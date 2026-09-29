import { z } from 'zod';

export const PROJECT_FEED_MAX_BYTES = 4 * 1024 * 1024;
export const PROJECT_FEED_MAX_EVENTS = 500;
const identity = z.string().min(1).max(200);
export const ProjectFeedInputSchema = z.object({
  projectId: identity,
  kind: z.enum(['commit', 'extension-installed', 'extension-uninstalled', 'project-created']),
  ts: z.number().finite(), title: z.string().max(256 * 1024), detail: z.string().max(64 * 1024).optional(),
  dedupeKey: z.string().min(1).max(4096),
}).strict();
export const ProjectFeedEventSchema = ProjectFeedInputSchema.extend({ id: z.string().min(1).max(256) });
export const ProjectFeedRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), projectId: identity }).strict(),
  z.object({ action: z.literal('append'), projectId: identity, events: z.array(ProjectFeedInputSchema).max(100) }).strict(),
]);
export type ProjectFeedRequest = z.infer<typeof ProjectFeedRequestSchema>;
export const ProjectFeedResultSchema = z.object({
  projectId: identity, hostId: identity, events: z.array(ProjectFeedEventSchema).max(PROJECT_FEED_MAX_EVENTS), added: z.number().int().min(0).max(100),
}).strict();
export type ProjectFeedResult = z.infer<typeof ProjectFeedResultSchema>;
