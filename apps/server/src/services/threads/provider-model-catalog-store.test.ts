import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSqliteDatabase, migrate, type ZccDatabase } from '@zana-ai/zcc-db';
import type { AvailableModel } from '@zana-ai/zcc-domain/thread-runtime';
import { ProviderModelCatalogStore } from './provider-model-catalog-store.js';

const model = (id: string): AvailableModel => ({
  id,
  model: id,
  displayName: id,
  description: id,
  supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Medium' }],
  defaultReasoningEffort: 'medium',
  isDefault: true
});

function database(): ZccDatabase {
  const sqlite = createSqliteDatabase(':memory:');
  sqlite.pragma('foreign_keys = ON');
  migrate(sqlite);
  sqlite.prepare(`INSERT INTO hosts (
    id, name, type, host_key_hash, created_at, updated_at
  ) VALUES ('host-1', 'Host', 'persistent', 'hash', 1, 1)`).run();
  return {
    file: ':memory:',
    sqlite,
    transaction: <T>(fn: () => T) => sqlite.transaction(fn)(),
    close: () => sqlite.close()
  };
}

const launch = {
  pluginId: 'provider-test',
  source: { kind: 'daemon-bundled' as const, id: 'fake' },
  capabilities: {
    supportsServiceTier: false,
    permissionModes: ['full'],
    supportsThreadArchive: false,
    supportsThreadRename: false,
    fork: 'none' as const
  }
};

describe('ProviderModelCatalogStore', () => {
  const databases: ZccDatabase[] = [];
  afterEach(() => databases.splice(0).forEach((db) => db.close()));

  it('coalesces discovery and persists a host-scoped catalog across store instances', async () => {
    const db = database(); databases.push(db);
    const rpc = vi.fn(async () => ({ models: [model('live')], selectedOnlyModels: [] }));
    const request = { hostId: 'host-1', providerId: 'fake', scope: 'host' as const, cwd: '/ignored', bridgeLaunch: launch };
    const store = new ProviderModelCatalogStore({ db, callHostOnlineRpc: rpc });
    const [first, second] = await Promise.all([store.read(request), store.read(request)]);
    expect(first.models[0]?.model).toBe('live');
    expect(second.models[0]?.model).toBe('live');
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0]?.[0].command).not.toHaveProperty('cwd');

    const restored = new ProviderModelCatalogStore({ db, callHostOnlineRpc: vi.fn() });
    expect((await restored.read(request)).models[0]?.model).toBe('live');
  });

  it('serves last-good data with an error when a forced refresh fails', async () => {
    const db = database(); databases.push(db);
    const rpc = vi.fn()
      .mockResolvedValueOnce({ models: [model('live')], selectedOnlyModels: [] })
      .mockRejectedValueOnce(new Error('provider model list timed out'));
    const store = new ProviderModelCatalogStore({ db, callHostOnlineRpc: rpc });
    const request = { hostId: 'host-1', providerId: 'fake', scope: 'workspace' as const, cwd: '/work', bridgeLaunch: launch };
    await store.read(request);
    const stale = await store.read({ ...request, forceRefresh: true });
    expect(stale.models[0]?.model).toBe('live');
    expect(stale.modelLoadError?.code).toBe('timeout');
    expect(rpc.mock.calls[0]?.[0].command.cwd).toBe('/work');
  });

  it('refreshes a young catalog when validation asks for a missing model', async () => {
    const db = database(); databases.push(db);
    let now = 1_000_000;
    const rpc = vi.fn()
      .mockResolvedValueOnce({ models: [model('old')], selectedOnlyModels: [] })
      .mockResolvedValueOnce({ models: [model('new')], selectedOnlyModels: [] });
    const store = new ProviderModelCatalogStore({ db, callHostOnlineRpc: rpc, now: () => now });
    const request = { hostId: 'host-1', providerId: 'fake', scope: 'host' as const, bridgeLaunch: launch };
    await store.read(request);
    now += 61_000;
    expect((await store.read({ ...request, requiredModel: 'new' })).models[0]?.model).toBe('new');
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('does not serve stale models across an authentication failure', async () => {
    const db = database(); databases.push(db);
    const rpc = vi.fn()
      .mockResolvedValueOnce({ models: [model('private')], selectedOnlyModels: [] })
      .mockRejectedValueOnce(Object.assign(new Error('authentication required'), { code: 'auth_required' }));
    const store = new ProviderModelCatalogStore({ db, callHostOnlineRpc: rpc });
    const request = { hostId: 'host-1', providerId: 'fake', scope: 'host' as const, bridgeLaunch: launch };
    await store.read(request);
    const result = await store.read({ ...request, forceRefresh: true });
    expect(result.models).toEqual([]);
    expect(result.modelLoadError?.code).toBe('auth_required');
  });
});
