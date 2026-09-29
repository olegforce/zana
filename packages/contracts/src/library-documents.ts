import { z } from 'zod';

export const LIBRARY_IMPORT_MAX_BYTES = 10 * 1024 * 1024;
export const LIBRARY_DOCUMENT_BODY_LIMIT = 15 * 1024 * 1024;

const Scope = { scope: z.enum(['global', 'project']), projectId: z.string().min(1).max(160).optional() };
const RelPath = z.string().min(1).max(4096).refine(value => !/[\\\x00-\x1f]/.test(value) && !/^[a-zA-Z]:/.test(value) && value.split('/').every(part => !!part && part !== '.' && part !== '..') && value !== 'index.json', 'Invalid library path');
const Metadata = { title: z.string().max(4096).optional(), summary: z.string().max(32_768).optional(), tags: z.array(z.string().max(256)).max(100).optional() };
const Location = z.object({ ...Scope, relPath: RelPath }).strict().refine(value => value.scope === 'project' ? !!value.projectId : !value.projectId, 'Project identity must match library scope');
export const LibraryDocumentRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('snapshot') }).strict(),
  z.object({ action: z.literal('search'), query: z.string().max(4096) }).strict(),
  z.object({ action: z.literal('createFolder'), ...Scope, relPath: RelPath }).strict(),
  z.object({ action: z.literal('deleteEntry'), ...Scope, relPath: RelPath }).strict(),
  z.object({ action: z.literal('move'), from: Location, to: Location }).strict(),
  z.object({ action: z.literal('read'), ...Scope, relPath: RelPath }).strict(),
  z.object({ action: z.literal('asset'), ...Scope, relPath: RelPath }).strict(),
  z.object({ action: z.literal('import'), ...Scope, relPath: RelPath, base64: z.string().max(Math.ceil(LIBRARY_IMPORT_MAX_BYTES / 3) * 4) }).strict(),
  z.object({ action: z.literal('write'), ...Scope, relPath: RelPath, content: z.string().max(10 * 1024 * 1024), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ action: z.literal('add'), ...Scope, relPath: RelPath, ...Metadata, title: z.string().min(1).max(4096), content: z.string().max(10 * 1024 * 1024).optional() }).strict(),
  z.object({ action: z.literal('update'), id: z.string().min(1).max(8192), patch: z.object(Metadata).strict(), location: Location.optional() }).strict(),
  z.object({ action: z.literal('remove'), id: z.string().min(1).max(8192), location: Location.optional() }).strict()
]).refine(value => !('scope' in value) || (value.scope === 'project' ? !!value.projectId : !value.projectId), 'Project identity must match library scope');
export type LibraryDocumentRequest = z.infer<typeof LibraryDocumentRequestSchema>;
