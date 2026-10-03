import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
const verify = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('./verify-packaged-plugin-build.mjs', () => ({ verifyPackagedPluginBuild: verify }));
import afterPack from './after-pack-trim-opencode.mjs';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.clearAllMocks(); });

it('checks the packaged Windows bootstrap before trimming or installing native bindings', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zcc-after-pack-')); roots.push(root);
  mkdirSync(join(root, 'resources'), { recursive: true });
  await afterPack({ appOutDir: root, electronPlatformName: 'win32', arch: 'x64' } as never);
  expect(verify).toHaveBeenCalledWith(join(root, 'resources', 'zcc-cli', 'bin', 'zcc'));
  verify.mockRejectedValueOnce(new Error('offline bootstrap failed'));
  await expect(afterPack({ appOutDir: root, electronPlatformName: 'win32', arch: 'x64' } as never)).rejects.toThrow('offline bootstrap failed');
});

it('fails closed before verification when macOS resources cannot be located', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zcc-after-pack-')); roots.push(root);
  await expect(afterPack({ appOutDir: root, electronPlatformName: 'darwin', arch: 'arm64' } as never)).rejects.toThrow('cannot locate packaged app resources');
  expect(verify).not.toHaveBeenCalled();
});
