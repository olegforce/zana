import type { Project } from '@zana-ai/zcc-domain/product';

/** Fixed metadata owner. Execution sources and client-selected hosts cannot override it. */
export function projectMetadataLocation(project: Pick<Project, 'path' | 'hostId' | 'remote'>): { path: string; hostId?: string } {
  if (project.remote) throw new Error('Shared project metadata is unavailable for this legacy SSH project');
  return { path: project.path, hostId: project.hostId };
}

/** Synchronous desktop stores cannot dereference another computer's path.
 * Even when a same-named directory exists here, only the fixed owner may read
 * or write that metadata. Adding a local execution source does not move it.
 */
export function localMetadataProjects(projects: Project[], localHostId?: string): Project[] {
  return projects.filter(project => !project.hostId || project.hostId === localHostId);
}

/** Legacy desktop discovery is local-only. An explicit remote or unknown path
 * must not become a local read or silently fall back to a global mutation. */
export function localProjectPathOptions(projects: Project[], localHostId: string | undefined, projectPath?: string): { projectPath?: string; projectId?: string } {
  if (projectPath === undefined) return {};
  const project = localMetadataProjects(projects, localHostId).find(p => p.path === projectPath);
  if (!project || typeof projectPath !== 'string' || !projectPath) throw new Error('Project discovery requires a registered project on this machine');
  return { projectPath: project.path, projectId: project.id };
}
