import { z } from 'zod';

export const ProjectHistoryRequestSchema = z.object({
  projectId: z.string().min(1).max(200), limit: z.number().int().min(1).max(100),
}).strict();
export type ProjectHistoryRequest = z.infer<typeof ProjectHistoryRequestSchema>;
export const ProjectHistoryResultSchema = z.array(z.object({
  hash: z.string().regex(/^[a-f0-9]{40,64}$/), shortHash: z.string().regex(/^[a-f0-9]{4,64}$/),
  author: z.string().max(4096), ts: z.number().finite(), subject: z.string().max(4 * 1024 * 1024),
}).strict()).max(100);
export type ProjectHistoryResult = z.infer<typeof ProjectHistoryResultSchema>;
