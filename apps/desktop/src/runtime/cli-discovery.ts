import { CliDiscoveryResultSchema, type CliDiscoveryRequest, type CliDiscoveryResult } from '@zana-ai/zcc-contracts/cli-discovery';
import type { TerminalExecutionDiscovery } from '@zana-ai/zcc-server/services/launch/execution-routing';

/** One launch's results only. A transport failure never invokes local discovery. */
export function createHostCliDiscovery(
  invoke: (request: CliDiscoveryRequest) => Promise<CliDiscoveryResult>,
  identity: Omit<CliDiscoveryRequest, 'query'>
): { installedVersion: () => Promise<string | undefined>; discovery: TerminalExecutionDiscovery } {
  const pending = new Map<CliDiscoveryRequest['query'], Promise<CliDiscoveryResult>>();
  function query<K extends CliDiscoveryRequest['query']>(kind: K): Promise<Extract<CliDiscoveryResult, { query: K }>> {
    const existing = pending.get(kind);
    if (existing) return existing as Promise<Extract<CliDiscoveryResult, { query: K }>>;
    const next = Promise.resolve().then(() => invoke({ ...identity, query: kind })).then(raw => {
      const result = CliDiscoveryResultSchema.parse(raw);
      if (result.query !== kind) throw new Error('CLI discovery reply does not match the request');
      return result;
    });
    pending.set(kind, next);
    return next as Promise<Extract<CliDiscoveryResult, { query: K }>>;
  }
  return {
    installedVersion: async () => {
      const result = await query('version');
      return result.version;
    },
    discovery: {
      roles: async () => {
        const result = await query('roles');
        return result.roles;
      },
      models: async () => {
        const result = await query('models');
        return result.models;
      }
    }
  };
}
