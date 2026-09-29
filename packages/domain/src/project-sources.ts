import type { Project } from './product.js';

/** BB's project + per-host local_path source model, stored additively in Zana's project record. */
export interface ProjectSource {
  id: string;
  hostId: string;
  path: string;
  createdAt: number;
}

export class ProjectSourceUnavailableError extends Error {
  constructor() { super('Add a checkout for this project on the selected machine'); }
}

/** Legacy path stays the metadata owner and default; extra sources never rewrite it. */
export function projectSources(project: Pick<Project, 'id' | 'path' | 'hostId' | 'sources' | 'createdAt' | 'remote'>, primaryHostId?: string): ProjectSource[] {
  const hostId = project.hostId ?? primaryHostId;
  const primary = hostId ? [{ id: `original:${project.id}`, hostId, path: project.remote?.remotePath ?? project.path, createdAt: project.createdAt }] : [];
  return [...primary, ...(project.sources ?? []).filter(source => source.hostId !== hostId)];
}

/** Selection is a projection for execution, never a mutation of the shared project. */
export function projectOnHost(project: Project, hostId: string, primaryHostId?: string): Project {
  const source = projectSources(project, primaryHostId).find(row => row.hostId === hostId);
  // Legacy SSH execution has its own host/proxy authorization. Ordinary source
  // selection must never hand a foreign host the original machine's path.
  if (!source) {
    if (project.remote || project.quickAgent) return project;
    throw new ProjectSourceUnavailableError();
  }
  if (source.id.startsWith('original:')) return project;
  return { ...project, path: source.path, hostId: source.hostId, remote: undefined };
}
