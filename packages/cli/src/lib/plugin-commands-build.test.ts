import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const deps = vi.hoisted(() => ({
  toolchain: { tag: 'cached-toolchain' }, build: vi.fn(), app: vi.fn(), server: vi.fn(), host: vi.fn(),
  download: vi.fn(), control: vi.fn(), loopOptions: null as any
}));
vi.mock('./control-client.js', () => ({ isAppRunning: () => true, callControlPlane: deps.control }));
vi.mock('@zana-ai/zcc-plugin-build', () => ({
  getPluginBuildToolchain: deps.download,
  buildPlugin: deps.build, buildPluginApp: deps.app, buildPluginServer: deps.server, buildPluginHost: deps.host,
  syncPluginTypes: vi.fn().mockResolvedValue(undefined),
  createPluginDevLoop: (opts: any) => {
    deps.loopOptions = opts;
    return { handleChange: vi.fn(), dispose: vi.fn(), flushNow: async () => {
      const targets = await opts.targets();
      if (targets.hasApp) await opts.buildApp();
      if (targets.hasServer) await opts.buildServer();
      if (targets.hasHost) await opts.buildHost();
      return { ok: true };
    } };
  }
}));
import { runPluginCommand } from './plugin-commands.js';
const roots: string[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  deps.download.mockImplementation(async (_dir, hooks) => { hooks.onFetchStart(); hooks.onFetchDone(); return deps.toolchain; });
  deps.control.mockResolvedValue({ ok: true, value: 'installed' });
  deps.build.mockResolvedValue({ app: { jsPath: 'app.js' }, host: { jsPath: 'host.cjs' } });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });
function fixture(zcc: object = {}) {
  const root = mkdtempSync(join(tmpdir(), 'zcc-cli-build-')); roots.push(root);
  const dir = join(root, 'source'), data = join(root, 'data');
  mkdirSync(dir); mkdirSync(join(data, 'plugins'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'zcc-plugin-test', zcc }));
  writeFileSync(join(data, 'plugins', 'installed.json'), JSON.stringify({ version: 1, plugins: [{ id: 'test', source: `path:${dir}` }] }));
  return { dir, data };
}
it('uses the downloaded toolchain and includes host artifacts in build output', async () => {
  const { dir, data } = fixture();
  expect((await runPluginCommand(data, 'build', [dir], false)).stdout).toContain('app.js host.cjs');
  expect(deps.build).toHaveBeenCalledWith(dir, '1.0.0', { toolchain: deps.toolchain });
  expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining('one time'));
  expect(process.stderr.write).toHaveBeenCalledWith('Plugin build toolchain ready.\n');
});
it.each([{ app: './app.tsx', host: './host.ts' }, { host: './host.ts' }, { app: './app.tsx' }, {}])('prepares local installs for %j', async zcc => {
  const { dir, data } = fixture(zcc);
  expect((await runPluginCommand(data, 'install', [`path:${dir}`], false)).exitCode).toBe(0);
  expect(deps.app).toHaveBeenCalledTimes('app' in zcc ? 1 : 0);
  expect(deps.host).toHaveBeenCalledTimes('host' in zcc ? 1 : 0);
  expect(deps.download).toHaveBeenCalledTimes(Object.keys(zcc).length ? 1 : 0);
  expect(deps.control).toHaveBeenCalledWith(expect.objectContaining({ args: { source: `path:${dir}` } }));
});
it('never installs a local plugin after host compilation fails', async () => {
  const { dir, data } = fixture({ host: './host.ts' });
  deps.host.mockRejectedValueOnce(new Error('host syntax error'));
  const result = await runPluginCommand(data, 'install', [`path:${dir}`], false);
  expect(result.stderr).toContain('Plugin preparation failed: host syntax error');
  expect(deps.control).not.toHaveBeenCalled();
});
it('rereads build targets after a manifest edit and supplies every builder the same toolchain', async () => {
  const { dir, data } = fixture({ app: './app.tsx', server: './server.mjs', host: './host.ts' });
  expect((await runPluginCommand(data, 'dev', [dir, '--once'], false)).exitCode).toBe(0);
  expect(deps.app).toHaveBeenCalledWith(dir, '1.0.0', { minify: false, sourcemap: true, toolchain: deps.toolchain });
  expect(deps.server).toHaveBeenCalledWith(dir, '1.0.0', { minify: false, sourcemap: true, toolchain: deps.toolchain });
  expect(deps.host).toHaveBeenCalledWith(dir, '1.0.0', deps.toolchain);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ zcc: { server: './server.ts' } }));
  expect(await deps.loopOptions.targets()).toEqual({ hasApp: false, hasServer: false, hasHost: false });
  writeFileSync(join(dir, 'package.json'), '{}');
  expect(await deps.loopOptions.targets()).toEqual({ hasApp: false, hasServer: false, hasHost: false });
});
