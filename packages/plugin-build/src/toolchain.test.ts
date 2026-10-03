import { cp, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLUGIN_TOOLCHAIN_PINS, resolvePluginBuildToolchain, toolchainCacheDir } from './toolchain.js';
import { resolveBundledNpmCli } from './npm-cli.js';

let baseDir: string;
beforeEach(async () => { baseDir = await mkdtemp(join(tmpdir(), 'zcc-toolchain-test-')); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(baseDir, { recursive: true, force: true }); });

async function fakeNpm(extra = '', pins: Record<string, string> = PLUGIN_TOOLCHAIN_PINS) {
  const file = join(baseDir, 'npm.cjs');
  await writeFile(file, `
const fs = require('node:fs');
const path = require('node:path');
const prefix = process.argv[process.argv.indexOf('--prefix') + 1];
fs.appendFileSync(${JSON.stringify(join(baseDir, 'calls'))}, 'install\\n');
${extra}
for (const [name, version] of Object.entries(${JSON.stringify(pins)})) {
  const dir = path.join(prefix, 'node_modules', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name, version, main:'index.cjs'}));
  fs.writeFileSync(path.join(dir, 'index.cjs'), 'module.exports = {};');
}
`);
  return { ignoreLocal: true, npmCliPath: file };
}

async function leftovers() {
  return (await readdir(baseDir)).filter((name) => name.includes('.staging-') || name.endsWith('.lock'));
}

describe('plugin build toolchain', () => {
  it('keys durable caches on versions and native runtime architecture', () => {
    const name = basename(toolchainCacheDir(baseDir));
    for (const version of Object.values(PLUGIN_TOOLCHAIN_PINS)) expect(name).toContain(version);
    expect(name).toContain(`${process.platform}-${process.arch}`);
  });

  it('uses importable pinned local tools without downloading', async () => {
    const fetch = vi.fn();
    const tools = await resolvePluginBuildToolchain(baseDir, { onFetchStart: fetch });
    expect(fetch).not.toHaveBeenCalled();
    const esbuild = await import(tools.esbuild) as typeof import('esbuild');
    expect((await esbuild.transform('const x: number = 1', { loader: 'ts' })).code.trim()).toBe('const x = 1;');
    expect(tools.tailwindNode).toContain('@tailwindcss/node');
    expect(resolveBundledNpmCli()).toMatch(/npm-cli\.js$/);
  });

  it('fetches once for concurrent callers and reuses the cache offline', async () => {
    const options = await fakeNpm();
    const start = vi.fn(), done = vi.fn();
    const tools = await Promise.all(Array.from({ length: 6 }, () => resolvePluginBuildToolchain(baseDir, { ...options, onFetchStart: start, onFetchDone: done })));
    expect(start).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledOnce();
    expect(new Set(tools.map((tool) => tool.esbuild)).size).toBe(1);
    expect(tools[0].esbuild).toContain('toolchain-');
    const cached = await resolvePluginBuildToolchain(baseDir, { ignoreLocal: true, npmCliPath: '/no/npm' });
    expect(cached).toEqual(tools[0]);
    expect((await readFile(join(baseDir, 'calls'), 'utf8')).trim()).toBe('install');
    expect(await leftovers()).toEqual([]);
  });

  it.each(['missing-marker', 'primitive-marker', 'invalid-json', 'wrong-pins', 'broken-package'])('repairs a %s cache after validating its replacement', async (kind) => {
    const dir = toolchainCacheDir(baseDir);
    await mkdir(dir);
    if (kind === 'primitive-marker') await writeFile(join(dir, '.zcc-toolchain.json'), 'null');
    if (kind === 'invalid-json') await writeFile(join(dir, '.zcc-toolchain.json'), 'oops');
    if (kind === 'wrong-pins') await writeFile(join(dir, '.zcc-toolchain.json'), JSON.stringify({ pins: 'old' }));
    if (kind === 'broken-package') {
      const options = await fakeNpm();
      await resolvePluginBuildToolchain(baseDir, options);
      await rm(join(dir, 'node_modules/esbuild'), { recursive: true });
    }
    const tools = await resolvePluginBuildToolchain(baseDir, await fakeNpm());
    expect(tools.esbuild).toContain('toolchain-');
    expect(await leftovers()).toEqual([]);
  });

  it('rejects incomplete and wrong-version downloads, cleans up and permits retry', async () => {
    await expect(resolvePluginBuildToolchain(baseDir, await fakeNpm('', { esbuild: '0.0.0' }))).rejects.toThrow('incomplete or misversioned');
    expect(await leftovers()).toEqual([]);
    await expect(resolvePluginBuildToolchain(baseDir, await fakeNpm())).resolves.toHaveProperty('esbuild');
  });

  it('bounds a hung bootstrap and recovers', async () => {
    const options = await fakeNpm('setInterval(() => {}, 1000);');
    await expect(resolvePluginBuildToolchain(baseDir, { ...options, timeoutMs: 100 })).rejects.toThrow();
    expect(await leftovers()).toEqual([]);
    await expect(resolvePluginBuildToolchain(baseDir, await fakeNpm())).resolves.toHaveProperty('esbuild');
  });

  it('reports npm errors without caching success', async () => {
    const options = await fakeNpm('process.stderr.write("registry unavailable"); process.exit(17);');
    await expect(resolvePluginBuildToolchain(baseDir, options)).rejects.toThrow('registry unavailable');
    expect(await leftovers()).toEqual([]);
  });

  it('uses a cache completed by another process while waiting for its lock', async () => {
    const other = join(baseDir, 'other');
    await resolvePluginBuildToolchain(other, await fakeNpm());
    const target = toolchainCacheDir(baseDir);
    await mkdir(`${target}.lock`);
    const waiting = resolvePluginBuildToolchain(baseDir, { ignoreLocal: true, npmCliPath: '/must-not-fetch', lockWaitMs: 2000 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await cp(toolchainCacheDir(other), target, { recursive: true });
    await rm(`${target}.lock`, { recursive: true });
    expect((await waiting).esbuild).toContain(target);
    expect((await readFile(join(baseDir, 'calls'), 'utf8')).trim()).toBe('install');
    expect(await leftovers()).toEqual([]);
  });

  it('recovers expired process locks and bounds a live lock wait', async () => {
    const lock = `${toolchainCacheDir(baseDir)}.lock`;
    await mkdir(lock);
    await expect(resolvePluginBuildToolchain(baseDir, { ...await fakeNpm(), lockWaitMs: 0 })).rejects.toThrow('timed out waiting');
    const old = new Date(Date.now() - 10 * 60_000);
    await utimes(lock, old, old);
    await expect(resolvePluginBuildToolchain(baseDir, await fakeNpm())).resolves.toHaveProperty('esbuild');
    expect(await leftovers()).toEqual([]);
  });

  it('keeps script-policy configuration out of npm while preserving its registry', async () => {
    vi.stubEnv('npm_config_allow_scripts', 'private-bin');
    vi.stubEnv('NPM_CONFIG_IGNORE_SCRIPTS', 'false');
    vi.stubEnv('npm_config_registry', 'https://registry.example.invalid/');
    const file = join(baseDir, 'env.json');
    await resolvePluginBuildToolchain(baseDir, await fakeNpm(`fs.writeFileSync(${JSON.stringify(file)}, JSON.stringify({allow:process.env.npm_config_allow_scripts,ignore:process.env.NPM_CONFIG_IGNORE_SCRIPTS,registry:process.env.npm_config_registry}));`));
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ registry: 'https://registry.example.invalid/' });
  });
});
