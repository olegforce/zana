import { z } from 'zod';

// Only main's authenticated MCP route supplies project/session identity. This
// operation is private utility-process RPC, never part of the renderer API.
const Base = { projectId: z.string().min(1).max(160), sessionId: z.string().min(1).max(160).optional() };
const Path = z.string().min(1).max(4096).refine(value => !/[\\\x00-\x1f]/.test(value) && !/^[a-zA-Z]:/.test(value) && value.split('/').every(part => !!part && !part.startsWith('.') && part !== 'index.json'));
export const LibraryAgentRequestSchema = z.discriminatedUnion('action', [
  z.object({ ...Base, action: z.literal('list') }).strict(),
  z.object({ ...Base, action: z.literal('read'), relPath: Path }).strict(),
  z.object({ ...Base, action: z.literal('remove'), relPath: Path }).strict(),
  z.object({ ...Base, action: z.literal('write'), relPath: Path, content: z.string().max(10 * 1024 * 1024).optional(), title: z.string().max(4096).optional(), summary: z.string().max(32_768).optional(), tags: z.array(z.string().max(256)).max(100).optional() }).strict()
]);
export type LibraryAgentRequest = z.infer<typeof LibraryAgentRequestSchema>;
