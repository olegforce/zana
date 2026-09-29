import { posix } from 'node:path';
import { PROJECT_CATALOG_KINDS, ProjectCatalogRequestSchema, type ProjectCatalogResult } from '@zana-ai/zcc-contracts/project-metadata-records';
import type { HostListDirResult, HostReadPathResult, HostRpcCommand } from '@zana-ai/zcc-contracts/host-rpc';
import type { ProductHttpContext } from '../../http/product-context.js';
import { resolveProjectHost } from '../../http/project-host.js';
import { projectMetadataLocation } from './project-metadata.js';

/** No paths or machine selectors cross this private read-only boundary. */
export async function readProjectCatalogs(ctx: ProductHttpContext, raw: unknown, requestDeadline = Date.now() + 15_000): Promise<ProjectCatalogResult> {
  const { projectId } = ProjectCatalogRequestSchema.parse(raw);
  const project = ctx.toProjects().find(row => row.id === projectId);
  if (!project) throw new Error('Unknown catalogue project');
  const owner = projectMetadataLocation(project), hostId = resolveProjectHost(ctx, owner.hostId);
  ctx.hostHub.ensureHostSessionReady(hostId);
  const deadline = Math.min(requestDeadline, Date.now() + 15_000);
  const rpc = <T>(command: HostRpcCommand): Promise<T> => {
    const timeoutMs = deadline - Date.now();
    if (timeoutMs <= 0) throw new Error('Project catalogue read timed out');
    return ctx.hostHub.callHostOnlineRpc<T>({ hostId, command, timeoutMs });
  };
  const result: ProjectCatalogResult = { projectId, hostId, personas: [], teams: [], templates: [] };
  let bytes = 0;
  for (const kind of PROJECT_CATALOG_KINDS) {
    const prefix = `.zcc/${kind}`, boundaryPath = posix.join(owner.path, prefix);
    let listing: HostListDirResult;
    try { listing = await rpc({ type: 'host.list_dir', root: owner.path, boundaryPath, relPath: prefix }); }
    catch (error) { if ((error as { code?: string }).code === 'path_not_found') continue; throw error; }
    if (listing.entries.length >= 2000) throw new Error('Project catalogue directory exceeds the complete listing limit');
    const files = listing.entries.filter(entry => entry.name.endsWith('.json'));
    if (files.length > 256) throw new Error('Project catalogue has too many records');
    for (const file of files) {
      if (file.kind !== 'file' || !/^[a-zA-Z0-9._-]+\.json$/.test(file.name)) throw new Error('Invalid project catalogue filename');
      let body: HostReadPathResult;
      try { body = await rpc({ type: 'host.read_path', rootPath: owner.path, boundaryPath, path: posix.join(boundaryPath, file.name) }); }
      catch (error) { if ((error as { code?: string }).code === 'path_not_found') continue; throw error; }
      const size = Buffer.byteLength(body.content);
      if (body.contentEncoding !== 'utf8' || size > 256 * 1024) throw new Error('Project catalogue record must be UTF-8 JSON under 256 KiB');
      bytes += size;
      if (bytes > 2 * 1024 * 1024) throw new Error('Project catalogue exceeds 2 MiB');
      result[kind].push(body.content);
    }
  }
  return result;
}
