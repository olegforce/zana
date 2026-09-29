import { ProjectHistoryRequestSchema, ProjectHistoryResultSchema, type ProjectHistoryResult } from '@zana-ai/zcc-contracts/project-history';
import type { ProductHttpContext } from '../../http/product-context.js';
import { resolveProjectHost } from '../../http/project-host.js';
import { projectMetadataLocation } from './project-metadata.js';

/** Feed history belongs to the canonical project source, never a coincident
 * local path or a browser-selected checkout. Offline preserves the saved feed. */
export async function readProjectHistory(ctx: ProductHttpContext, raw: unknown, deadline: number): Promise<ProjectHistoryResult> {
  const { projectId, limit } = ProjectHistoryRequestSchema.parse(raw);
  const project = ctx.toProjects().find(row => row.id === projectId);
  if (!project) throw new Error('Unknown history project');
  const owner = projectMetadataLocation(project), hostId = resolveProjectHost(ctx, owner.hostId);
  ctx.hostHub.ensureHostSessionReady(hostId);
  const timeoutMs = Math.min(15_000, deadline - Date.now());
  if (timeoutMs <= 0) throw new Error('Project history read timed out');
  const result = await ctx.hostHub.callHostOnlineRpc({ hostId, timeoutMs, command: { type: 'host.git_history', root: owner.path, limit } });
  return ProjectHistoryResultSchema.parse(result);
}
