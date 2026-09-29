import { z } from 'zod';
import { VALID_PROFILES } from '@zana-ai/zcc-domain/launch-provider';

const text = z.string().min(1).max(4096).refine(value => !value.includes('\0'));
export const CliDiscoveryQuerySchema = z.enum(['version', 'roles', 'models']);
export const CliDiscoveryRequestSchema = z.object({
  projectId: z.string().min(1).max(200),
  hostId: z.string().uuid().optional(),
  environmentId: z.string().uuid().optional(),
  cwd: text.optional(),
  profile: z.enum(VALID_PROFILES),
  query: CliDiscoveryQuerySchema,
  nativeAgentDiscoveryEnabled: z.boolean()
}).strict();
export type CliDiscoveryRequest = z.infer<typeof CliDiscoveryRequestSchema>;

export const CliDiscoveryCommandSchema = CliDiscoveryRequestSchema.omit({
  projectId: true, hostId: true, environmentId: true
}).extend({ type: z.literal('provider.cli_discovery'), root: text, cwd: text }).strict();
export type CliDiscoveryCommand = z.infer<typeof CliDiscoveryCommandSchema>;

export const CliDiscoveryResultSchema = z.discriminatedUnion('query', [
  z.object({ query: z.literal('version'), version: z.string().min(1).max(200).optional() }).strict(),
  z.object({ query: z.literal('roles'), roles: z.array(z.object({
    id: text, label: text,
    executionStates: z.array(z.enum(['plan', 'interactive', 'accept-edits', 'autonomous'])).max(4).optional(),
    scope: z.array(z.enum(['local', 'remote'])).max(2),
    evidenceVersion: z.string().max(200).optional()
  }).strict()).max(2000) }).strict(),
  z.object({ query: z.literal('models'), models: z.array(text).max(10000).optional() }).strict()
]);
export type CliDiscoveryResult = z.infer<typeof CliDiscoveryResultSchema>;
