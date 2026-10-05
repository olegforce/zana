import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  scanError: undefined as unknown,
  runtimes: [] as Array<{ options: Parameters<typeof import('./isolated-plugin-runtime.js').createIsolatedPluginRuntime>[0]; dispose: ReturnType<typeof vi.fn> }>
}));
vi.mock('./plugin-file-scan.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./plugin-file-scan.js')>();
  return { ...actual, scanPluginFiles: async (dir: string) => { if (state.scanError !== undefined) throw state.scanError; return actual.scanPluginFiles(dir); } };
});
vi.mock('./isolated-plugin-runtime.js', () => ({ createIsolatedPluginRuntime: (options: Parameters<typeof import('./isolated-plugin-runtime.js').createIsolatedPluginRuntime>[0]) => {
  options.api.rpc.method('ping', () => 'alive');
  const dispose = vi.fn(); state.runtimes.push({ options, dispose });
  return { started: Promise.resolve(), dispose };
} }));
import { createPluginService } from './plugin-service.js';

const roots: string[] = [], services: ReturnType<typeof createPluginService>[] = [];
function root() { const dir = mkdtempSync(join(tmpdir(), 'plugin-failure-owner-')); roots.push(dir); return dir; }
function fixture(onAppsChanged?: () => void) {
  const dir = root(); mkdirSync(join(dir, 'plugin'));
  const plugin = join(dir, 'plugin');
  writeFileSync(join(plugin, 'package.json'), JSON.stringify({ name: 'zcc-plugin-failure-fixture', version: '0.1.0', engines: { zcc: '>=1.0.0', zccPluginSdk: '>=0.1.0' }, zcc: { name: 'Fixture', description: 'Failure fixture', branding: { icon: 'Puzzle' }, server: './server.mjs' } }));
  writeFileSync(join(plugin, 'server.mjs'), 'export default function () {}');
  const service = createPluginService({ dataDir: root(), bundledRoot: root(), onAppsChanged }); services.push(service);
  return { service, plugin };
}
afterEach(() => { for (const service of services.splice(0)) service.stop(); state.scanError = undefined; state.runtimes.length = 0; for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe('plugin service responsiveness failures', () => {
  it.each([Error('scan failed'), 'scan failed'])('degrades an initial installation when its bounded scan fails: %s', async error => {
    const { service, plugin } = fixture(); state.scanError = error;
    const row = await service.install(plugin);
    expect(service.get(row.id)).toMatchObject({ status: 'degraded', statusDetail: 'scan failed' });
    expect(state.runtimes).toHaveLength(0);
  });

  it('retains the running generation when a reload scan fails', async () => {
    const { service, plugin } = fixture(); const row = await service.install(plugin);
    state.scanError = Error('reload scan failed');
    await expect(service.reload(row.id)).rejects.toThrow('reload scan failed');
    expect(service.get(row.id)?.status).toBe('running');
    await expect(service.callRpc(row.id, 'ping', {})).resolves.toBe('alive');
    expect(state.runtimes[0].dispose).not.toHaveBeenCalled();
  });

  it('ignores a stale worker failure and degrades the current generation on failure', async () => {
    const changed = vi.fn(), { service, plugin } = fixture(changed); const row = await service.install(plugin);
    const previous = state.runtimes[0]; await service.reload(row.id); const current = state.runtimes[1];
    previous.options.onFailure(Error('stale failure'));
    expect(service.get(row.id)?.status).toBe('running');
    current.options.onFailure(Error('worker unresponsive'));
    await vi.waitFor(() => expect(service.get(row.id)).toMatchObject({ status: 'degraded', statusDetail: 'worker unresponsive' }));
    expect(current.dispose).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(3));
  });

  it('contains a rejected failure notification after persisting the degraded state', async () => {
    let rejectChanges = false;
    const changed = vi.fn(() => { if (rejectChanges) throw Error('notification failed'); });
    const { service, plugin } = fixture(changed);
    const row = await service.install(plugin); rejectChanges = true;
    state.runtimes[0].options.onFailure(Error('worker failed'));
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(2));
    expect(service.get(row.id)?.status).toBe('degraded');
  });
});
