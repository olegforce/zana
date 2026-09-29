import type { ProductHttpContext } from '../../http/product-context.js';
import { HOST_DATA_DIR_PROBE_SLUG, hostDataDirFromCloneDefaultPath, resolveManagedTargetPath } from './worktree-paths.js';

/** A remote checkout must never inherit the authoritative server's absolute HOME path. */
export async function managedPathOnHost(ctx: ProductHttpContext, hostId: string, primaryHostId: string | undefined, environmentId: string, sourcePath: string): Promise<string> {
  const dataDir = hostId === primaryHostId ? ctx.dataDir : hostDataDirFromCloneDefaultPath((await ctx.hostHub.callHostOnlineRpc<{ path: string }>({
    hostId, command: { type: 'project.clone_default_path', projectSlug: HOST_DATA_DIR_PROBE_SLUG }
  })).path);
  return resolveManagedTargetPath({ dataDir, environmentId, sourcePath });
}
