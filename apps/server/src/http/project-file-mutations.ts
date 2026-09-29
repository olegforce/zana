import { z } from 'zod';
import type { HostRpcCommand, HostWriteFileResult } from '@zana-ai/zcc-contracts/host-rpc';
import type { FsMutateResult, FsWriteResult } from '@zana-ai/zcc-domain/product';
import type { ProductHttpContext } from './product-context.js';
import { authorizeScopedPath, parseProjectFileScope, ProjectFsError } from './project-fs-via-host.js';
import { isSafeRelPath } from './library-via-host.js';
import { resolveProjectHost } from './project-host.js';

const path = z.string().min(1).max(4096).refine(value => !/[\x00-\x1f]/.test(value));
const common = { path, scope: z.unknown().optional() };
const mutation = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('write'), ...common, content: z.string().max(2 * 1024 * 1024), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ operation: z.literal('create-file'), ...common }).strict(),
  z.object({ operation: z.literal('create-dir'), ...common }).strict(),
  z.object({ operation: z.literal('rename'), ...common, destination: path }).strict(),
  z.object({ operation: z.literal('delete'), ...common }).strict()
]);

/** Both paths and the host come from registered sources/environments. The host
 * repeats realpath confinement. No arbitrary root or RPC type is accepted. */
export async function mutateProjectFile(ctx: ProductHttpContext, input: unknown): Promise<FsMutateResult & FsWriteResult> {
  const parsed = mutation.safeParse(input);
  if (!parsed.success) throw new ProjectFsError(400, 'invalid-mutation', 'Invalid file operation; saving requires the revision read from this machine');
  const body = parsed.data;
  const scope = parseProjectFileScope(body.scope);
  const source = authorizeScopedPath(ctx, body.path, scope);
  if (!source?.relPath || !isSafeRelPath(source.relPath)) throw new ProjectFsError(403, 'path-escape', 'Choose a path inside the selected checkout');
  const hostId = resolveProjectHost(ctx, source.hostId);
  let command: HostRpcCommand;
  switch (body.operation) {
    case 'write':
    case 'create-file':
      command = { type: 'host.write_file', path: body.path, rootPath: source.root, content: body.operation === 'write' ? body.content : '', contentEncoding: 'utf8', createParents: false, expectedSha256: body.operation === 'write' ? body.expectedSha256 : null };
      break;
    case 'create-dir': command = { type: 'host.mkdir', path: body.path, rootPath: source.root, recursive: false }; break;
    case 'delete': command = { type: 'host.remove_path', path: body.path, rootPath: source.root, recursive: true }; break;
    case 'rename': {
      const target = authorizeScopedPath(ctx, body.destination, scope);
      if (!target?.relPath || !isSafeRelPath(target.relPath) || target.root !== source.root || target.hostId !== source.hostId) throw new ProjectFsError(403, 'path-escape', 'Both paths must belong to the same checkout');
      command = { type: 'host.move_path', sourcePath: body.path, destinationPath: body.destination, rootPath: source.root };
    }
  }
  const result = await ctx.hostHub.callHostOnlineRpc<HostWriteFileResult | { ok: true }>({ hostId, command });
  if ('outcome' in result && result.outcome === 'conflict') return { ok: false, message: body.operation === 'create-file' ? 'A file already exists at that path.' : 'This file changed on its machine. Reload it before saving.' };
  return { ok: true, path: body.operation === 'rename' ? body.destination : body.path, ...('sha256' in result ? { sha256: result.sha256 } : {}) };
}
