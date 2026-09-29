import type { IncomingMessage, ServerResponse } from 'node:http';
import { countLiveThreadsForEnvironment, listEnvironmentsByProject, getHost, getPrimaryHost } from '@zana-ai/zcc-db';
import { projectSources } from '@zana-ai/zcc-domain/project';
import type { ProductHttpContext } from './product-context.js';
import { readJsonBody, sendJson } from './json.js';

export async function handleProjectSourcesApi(req: IncomingMessage, res: ServerResponse, ctx: ProductHttpContext, path: string, method: string): Promise<boolean> {
  const match = /^\/api\/v1\/projects\/([^/]+)\/sources(?:\/([^/]+))?$/.exec(path);
  if (!match) return false;
  const projectId = decodeURIComponent(match[1]!);
  const project = ctx.toProjects().find(row => row.id === projectId);
  if (!project) { sendJson(res, 404, { error: 'Project is not registered' }); return true; }
  const primary = getPrimaryHost(ctx.db);
  if (method === 'GET' && !match[2]) { sendJson(res, 200, { sources: projectSources(project, primary?.id) }); return true; }
  if (method === 'POST' && !match[2]) {
    const body = await readJsonBody(req) as { hostId?: unknown; path?: unknown };
    if (!body || typeof body.hostId !== 'string' || typeof body.path !== 'string' || !body.path.startsWith('/') || body.path.length > 4096 || /[\x00-\x1f]/.test(body.path) || Object.keys(body).some(key => key !== 'hostId' && key !== 'path')) { sendJson(res, 400, { error: 'Choose a machine and an absolute checkout path' }); return true; }
    const host = getHost(ctx.db, body.hostId);
    if (!host || host.destroyedAt || !primary) { sendJson(res, 404, { error: 'Machine is not registered' }); return true; }
    try {
      ctx.hostHub.ensureHostSessionReady(host.id);
      const canonical = await ctx.hostHub.callHostOnlineRpc<{ directory: string }>({ hostId: host.id, command: { type: 'host.browse_directory', path: body.path } });
      if (!canonical.directory?.startsWith('/')) throw new Error('Machine returned an invalid directory');
      const updated = await ctx.projects.addSource(projectId, { hostId: host.id, path: canonical.directory }, primary.id);
      ctx.hub.emit('projects:changed', ctx.projects.list());
      sendJson(res, 201, { project: updated });
    } catch (error) { sendJson(res, 409, { error: error instanceof Error ? error.message : 'Source could not be added' }); }
    return true;
  }
  if (method === 'DELETE' && match[2]) {
    try {
      const sourceId = decodeURIComponent(match[2]);
      const source = project.sources?.find(row => row.id === sourceId);
      if (source && (listEnvironmentsByProject(ctx.db, projectId, source.hostId).some(environment => countLiveThreadsForEnvironment(ctx.db, environment.id) > 0) || [...ctx.terminalSessions.values()].some(session => session.projectId === projectId && session.hostId === source.hostId && session.status !== 'exited'))) {
        sendJson(res, 409, { error: 'Stop active threads and terminals on this machine before removing its checkout' }); return true;
      }
      const updated = await ctx.projects.removeSource(projectId, sourceId);
      ctx.hub.emit('projects:changed', ctx.projects.list());
      sendJson(res, 200, { project: updated });
    } catch (error) { sendJson(res, 409, { error: error instanceof Error ? error.message : 'Source could not be removed' }); }
    return true;
  }
  sendJson(res, 405, { error: 'Method not allowed' }); return true;
}
