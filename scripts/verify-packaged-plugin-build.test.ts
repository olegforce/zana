import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { verifyPackagedPluginBuild } from './verify-packaged-plugin-build.mjs';

const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function cli(mode = 'ok') {
  const dir = mkdtempSync(join(tmpdir(), 'zcc-release-probe-test-')); roots.push(dir);
  const file = join(dir, 'cli.cjs');
  const log = join(dir, 'calls.jsonl');
  writeFileSync(file, `
const fs = require('node:fs');
const path = require('node:path');
const plugin = process.cwd();
const cold = process.env.npm_config_registry.startsWith('https:');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({cold,home:process.env.HOME,data:process.env.ZCC_DATA_DIR,plugin,session:process.env.ZCC_SESSION_ID})+'\\n');
if (${JSON.stringify(mode)} === 'error') { process.stderr.write('build failed'); process.exit(2); }
fs.mkdirSync(path.join(plugin,'dist'),{recursive:true});
fs.writeFileSync(path.join(plugin,'dist/host.js'),'releaseHost');
fs.writeFileSync(path.join(plugin,'app.js'),${JSON.stringify(mode)} === 'incomplete' || (${JSON.stringify(mode)} === 'offline-error' && !cold) ? 'broken' : 'navPanel');
`);
  return { file, log };
}

it('checks cold bootstrap and offline rebuilding with isolated data and cleans its temporary project', async () => {
  const probe = cli();
  await verifyPackagedPluginBuild(probe.file);
  const calls = readFileSync(probe.log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  expect(calls.map((call) => call.cold)).toEqual([true, false]);
  expect(calls[0].home).toBe(calls[1].home);
  expect(calls[0].data).toBe(join(calls[0].home, 'data'));
  expect(calls[0]).not.toHaveProperty('session');
  expect(existsSync(calls[0].home)).toBe(false);
});

it.each([
  ['error', 'build failed'],
  ['incomplete', 'packaged plugin bundles are incomplete'],
  ['offline-error', 'offline cached plugin build failed']
])('blocks a release on %s and still cleans the probe', async (mode, message) => {
  const probe = cli(mode);
  await expect(verifyPackagedPluginBuild(probe.file)).rejects.toThrow(message);
  const call = JSON.parse(readFileSync(probe.log, 'utf8').split('\n')[0]);
  expect(existsSync(call.home)).toBe(false);
});

it('runs as a release command and requires a shipped CLI argument', async () => {
  const probe = cli();
  const originalArgs = process.argv;
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const script = fileURLToPath(new URL('./verify-packaged-plugin-build.mjs', import.meta.url));
  try {
    process.argv = [process.execPath, script, probe.file];
    vi.resetModules();
    await import('./verify-packaged-plugin-build.mjs');
    expect(output).toHaveBeenCalledWith('Packaged plugin builds passed: cold bootstrap and offline cache.');
    process.argv = [process.execPath, script];
    vi.resetModules();
    await expect(import('./verify-packaged-plugin-build.mjs')).rejects.toThrow('Usage:');
  } finally {
    process.argv = originalArgs;
    output.mockRestore();
    vi.resetModules();
  }
});
