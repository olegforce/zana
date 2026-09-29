import type { ProjectCatalogSource } from '@zana-ai/zcc-contracts/project-metadata-records';
import type { Project } from '@zana-ai/zcc-domain/product';

type CatalogSource = { kind: 'local'; project: Project } | { kind: 'remote'; source: ProjectCatalogSource };

/** Keep project override order independent of the machine owning its files.
 * The order supplies identity only: it must never introduce a filesystem root. */
export function orderedCatalogSources(local: Project[], remote: ProjectCatalogSource[], order?: readonly string[]): CatalogSource[] {
  const byId = new Map<string, CatalogSource>();
  for (const project of local) byId.set(project.id, { kind: 'local', project });
  for (const source of remote) if (!byId.has(source.projectId)) byId.set(source.projectId, { kind: 'remote', source });
  if (!order) return [...byId.values()];
  const seen = new Set<string>();
  return order.flatMap(id => {
    const source = byId.get(id);
    if (!source || seen.has(id)) return [];
    seen.add(id);
    return [source];
  });
}
