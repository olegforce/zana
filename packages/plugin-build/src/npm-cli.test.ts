import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { resolveBundledNpmCli } from './npm-cli.js';

const { exists } = vi.hoisted(() => ({ exists: vi.fn() }));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  exists.mockImplementation(fs.existsSync);
  return { ...fs, existsSync: exists };
});

it('falls back to the workspace npm package when no runtime has been built', () => {
  exists.mockReturnValue(false);
  try {
    expect(resolveBundledNpmCli().replaceAll('\\', '/')).toMatch(/node_modules\/.*npm\/bin\/npm-cli\.js$/);
  } finally { exists.mockReset(); }
});

it('locates bundled npm in the packaged desktop resources', async () => {
  exists.mockImplementation((await vi.importActual<typeof import('node:fs')>('node:fs')).existsSync);
  const resources = await mkdtemp(join(tmpdir(), 'zcc-npm-resources-'));
  const file = join(resources, 'zcc-cli/runtime/npm/bin/npm-cli.js');
  const runtime = process as NodeJS.Process & { resourcesPath?: string };
  const previous = runtime.resourcesPath;
  try {
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, '// bundled npm');
    runtime.resourcesPath = resources;
    expect(resolveBundledNpmCli()).toBe(file);
  } finally {
    if (previous === undefined) delete runtime.resourcesPath; else runtime.resourcesPath = previous;
    await rm(resources, { recursive: true, force: true });
  }
});
