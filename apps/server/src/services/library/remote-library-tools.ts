import { resolveProjectHost } from '../../http/project-host.js';
import { remoteLibraryIo } from './remote-library-io.js';
import { commitRemoteLibraryTransaction, recoverRemoteLibraryTransaction } from './remote-library-transaction.js';
import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import type { Project, LibraryDoc, LibraryManifest } from '@zana-ai/zcc-domain/product';
import type { ToolCallResponse } from '@zana-ai/zcc-domain/thread-runtime';
import { listLibraryFiles } from './list-library-files.js';
import type { ProductHttpContext } from '../../http/product-context.js';
import { pluginToolResultToResponse } from '../../plugins/plugin-agent-tools.js';
import { projectMetadataLocation } from '../projects/project-metadata.js';
import { kindFromExt, parseFrontMatter, serializeFrontMatter, summarize, validateAgentRelPath } from '../threads/host-library-tools.js';

/** Runs on the fixed metadata host, even when the calling thread executes elsewhere. */
export async function invokeRemoteLibraryTool(ctx: ProductHttpContext, project: Project, args: { name: string; threadId?: string; projectId: string; input: unknown }, deadline = Date.now() + 15_000): Promise<ToolCallResponse> {
  const owner = projectMetadataLocation(project), hostId = resolveProjectHost(ctx, owner.hostId);
  ctx.hostHub.ensureHostSessionReady(hostId);
  const fields = args.input && typeof args.input === 'object' && !Array.isArray(args.input) ? args.input as Record<string, unknown> : {};
  const prefix = '.zcc/library/';
  const io = remoteLibraryIo(ctx, hostId, owner.path, deadline);
  if (await recoverRemoteLibraryTransaction(io)) ctx.hub.emit('library:changed', { projectId: project.id });
  const read = (relPath: string) => io.read(prefix + relPath);
  const manifestText = await read('index.json');
  const manifest: LibraryManifest = manifestText ? JSON.parse(manifestText) : { version: 1, docs: [] };
  if (!Array.isArray(manifest.docs) || manifest.docs.length > 10_000) throw new Error('Invalid or oversized library manifest');
  if (args.name === 'library_list') {
    // List relative to the registered project, preserving its confinement anchor.
    const listing = await listLibraryFiles(ctx, hostId, owner.path, '.zcc/library', deadline);
    const docs = listing.map(relPath => {
      return manifest.docs.find(doc => doc.relPath === relPath) ?? { relPath, title: relPath, kind: kindFromExt(posix.extname(relPath)), updatedAt: 0 } as LibraryDoc;
    });
    return pluginToolResultToResponse(args.name, docs.map(summarize));
  }
  const relPath = typeof fields.relPath === 'string' ? fields.relPath : '';
  validateAgentRelPath(relPath);
  const existing = manifest.docs.find(doc => doc.relPath === relPath), raw = await read(relPath);
  const isMarkdown = kindFromExt(posix.extname(relPath)) === 'md';
  const fm = raw !== null && isMarkdown ? parseFrontMatter(raw) : null;
  if (args.name === 'library_read') {
    if (raw === null) throw new Error(`No such library document: ${relPath}`);
    const doc = existing ?? { relPath, title: fm?.meta.title ?? relPath, kind: kindFromExt(posix.extname(relPath)), updatedAt: 0 } as LibraryDoc;
    return pluginToolResultToResponse(args.name, { ...summarize(doc), content: fm?.body ?? raw });
  }
  if (args.name !== 'library_write' && args.name !== 'library_remove') throw new Error('Unsupported library operation');
  if ((existing && existing.source?.kind !== 'agent') || (!existing && raw !== null && fm?.meta.sourceKind !== 'agent')) throw new Error('Agents may only modify agent-authored library documents');
  if (args.name === 'library_remove') {
    await commitRemoteLibraryTransaction(io, { relPath, before: raw, after: null, beforeEntry: existing ?? null, afterEntry: null });
    ctx.hub.emit('library:changed', { projectId: project.id });
    return pluginToolResultToResponse(args.name, { ok: true, removed: raw !== null || !!existing, relPath });
  }
  if (fields.content !== undefined && typeof fields.content !== 'string') throw new Error('Content must be a string');
  if (fields.content === undefined && raw === null) throw new Error('Pass content to create a library document');
  const doc: LibraryDoc = { ...existing, id: existing?.id ?? randomUUID(), relPath,
    title: typeof fields.title === 'string' ? fields.title : existing?.title ?? relPath,
    summary: typeof fields.summary === 'string' ? fields.summary : existing?.summary,
    tags: Array.isArray(fields.tags) ? fields.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 100) : existing?.tags,
    kind: kindFromExt(posix.extname(relPath)), createdAt: existing?.createdAt ?? Date.now(), updatedAt: Date.now(), bytes: 0,
    source: { kind: 'agent', projectId: project.id, sessionId: args.threadId }
  };
  const content = typeof fields.content === 'string' ? fields.content : fm?.body ?? raw!;
  const formatted = isMarkdown ? serializeFrontMatter({ ...doc, sourceKind: 'agent' }, content) : content;
  if (Buffer.byteLength(formatted) > 10 * 1024 * 1024) throw new Error('Library document too large');
  doc.bytes = Buffer.byteLength(formatted);
  await commitRemoteLibraryTransaction(io, { relPath, before: raw, after: formatted, beforeEntry: existing ?? null, afterEntry: doc });
  ctx.hub.emit('library:changed', { projectId: project.id });
  return pluginToolResultToResponse(args.name, { ok: true, ...summarize(doc), bytes: doc.bytes });
}
