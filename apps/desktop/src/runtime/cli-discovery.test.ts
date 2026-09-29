import { expect, it, vi } from 'vitest';
import { createHostCliDiscovery } from './cli-discovery.js';
import type { CliDiscoveryRequest, CliDiscoveryResult } from '@zana-ai/zcc-contracts/cli-discovery';

const identity = { projectId: 'p', hostId: '958f6398-7da4-4bf7-a061-3bed9eae981a', profile: 'opencode' as const, cwd: '/source', nativeAgentDiscoveryEnabled: true };
it('binds every query to the chosen machine and coalesces only within one launch', async () => {
  const invoke = vi.fn(async (request: CliDiscoveryRequest): Promise<CliDiscoveryResult> => request.query === 'version'
    ? { query: 'version', version: '1.2.3' } : request.query === 'roles'
      ? { query: 'roles', roles: [] } : { query: 'models', models: ['m'] });
  const adapter = createHostCliDiscovery(invoke, identity);
  expect(await Promise.all([adapter.installedVersion(), adapter.installedVersion()])).toEqual(['1.2.3', '1.2.3']);
  expect(await adapter.discovery.roles()).toEqual([]); expect(await adapter.discovery.models()).toEqual(['m']);
  expect(invoke.mock.calls.map(([request]) => request)).toEqual(['version', 'roles', 'models'].map(query => ({ ...identity, query })));
  await createHostCliDiscovery(invoke, identity).installedVersion(); expect(invoke).toHaveBeenCalledTimes(4);
});
it('rejects mismatched, malformed and failed responses without retrying another machine', async () => {
  for (const result of [{ query: 'roles', roles: [] }, { query: 'version', version: 'v', token: 'private' }]) {
    const invoke = vi.fn(async () => result as CliDiscoveryResult);
    const adapter = createHostCliDiscovery(invoke, identity);
    await expect(adapter.installedVersion()).rejects.toThrow(); await expect(adapter.installedVersion()).rejects.toThrow();
    expect(invoke).toHaveBeenCalledTimes(1);
  }
  const invoke = vi.fn(async () => { throw new Error('offline'); });
  const adapter = createHostCliDiscovery(invoke, identity);
  await expect(adapter.installedVersion()).rejects.toThrow('offline'); expect(invoke).toHaveBeenCalledTimes(1);
});
