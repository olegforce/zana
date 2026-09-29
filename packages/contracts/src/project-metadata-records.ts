import { z } from 'zod';

export const ProjectMetadataKindSchema = z.enum(['schedules', 'goals', 'followups']);
export type ProjectMetadataKind = z.infer<typeof ProjectMetadataKindSchema>;
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/);
const base = z.object({ projectId: z.string().min(1).max(200), kind: ProjectMetadataKindSchema });
export const ProjectMetadataRequestSchema = z.discriminatedUnion('action', [
  base.extend({ action: z.literal('list') }).strict(),
  base.extend({ action: z.literal('write'), id, content: z.string().max(1024 * 1024), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable() }).strict(),
  base.extend({ action: z.literal('remove'), id, expectedSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
]);
export type ProjectMetadataRequest = z.infer<typeof ProjectMetadataRequestSchema>;
export interface ProjectMetadataRecord { id: string; content: string; sha256: string }
export interface ProjectMetadataResult {
  projectId: string;
  kind: ProjectMetadataKind;
  hostId: string;
  records: ProjectMetadataRecord[];
}

/** Read-only catalogues: the runtime resolves the original project owner. */
export const PROJECT_CATALOG_KINDS = ['personas', 'teams', 'templates'] as const;
export const ProjectCatalogRequestSchema = z.object({ projectId: z.string().min(1).max(200) }).strict();
export type ProjectCatalogRequest = z.infer<typeof ProjectCatalogRequestSchema>;
const CatalogRows = z.array(z.string().max(256 * 1024)).max(256);
export const ProjectCatalogResultSchema = z.object({
  projectId: z.string().min(1).max(200), hostId: z.string().min(1).max(200),
  personas: CatalogRows, teams: CatalogRows, templates: CatalogRows
}).strict();
export type ProjectCatalogResult = z.infer<typeof ProjectCatalogResultSchema>;
export interface ProjectCatalogSource { projectId: string; projectName: string; records: string[] }
