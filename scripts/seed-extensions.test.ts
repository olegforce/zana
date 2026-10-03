import { afterEach, expect, it, vi } from 'vitest';

const { spawnSync, readFileSync } = vi.hoisted(() => ({
  spawnSync: vi.fn(() => ({ status: 0 })),
  readFileSync: vi.fn(() => JSON.stringify({ scripts: { build: 'node build.mjs', package: 'node package.mjs' } }))
}));
vi.mock('node:child_process', () => ({ spawnSync }));
vi.mock('node:fs', () => ({
  existsSync: () => true,
  readdirSync: () => [{ name: 'example', isDirectory: () => true }],
  readFileSync
}));
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it.each(['build', 'package'])('reports a plugin %s failure without blocking other plugins', async phase => {
  vi.resetModules();
  vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  if (phase === 'package') spawnSync.mockImplementationOnce(() => ({ status: 0 }));
  spawnSync.mockImplementationOnce(() => ({ status: 1 }));
  await import('./seed-extensions.mjs');
  expect(spawnSync).toHaveBeenCalledTimes(phase === 'build' ? 1 : 2);
  expect(errors.mock.calls[0][0]).toContain(`${phase} failed`);
  expect(errors.mock.calls[1][0]).toContain('continuing');
  expect(process.exit).toHaveBeenCalledWith(0);
});

it.each(['broken-json', 'missing-scripts'])('skips a plugin with %s', async kind => {
  vi.resetModules();
  vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  readFileSync.mockReturnValueOnce(kind === 'broken-json' ? '{' : '{}');
  await import('./seed-extensions.mjs');
  expect(spawnSync).not.toHaveBeenCalled();
});

it.each(['win32', 'darwin'])('runs plugin build/package through the Windows command shell only on %s', async target => {
  vi.resetModules();
  Object.defineProperty(process, 'platform', { value: target });
  vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  await import('./seed-extensions.mjs');
  expect(spawnSync.mock.calls).toEqual([
    ['npm', ['run', 'build', '--silent'], expect.objectContaining({ shell: target === 'win32', stdio: 'inherit' })],
    ['npm', ['run', 'package', '--silent'], expect.objectContaining({ shell: target === 'win32', stdio: 'inherit' })]
  ]);
});
