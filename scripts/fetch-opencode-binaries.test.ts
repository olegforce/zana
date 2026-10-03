import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { binaryTargets, fetchBinary, OPENCODE_VERSION } from './fetch-opencode-binaries.mjs';

describe('OpenCode release binaries', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  function workspace() {
    const root = mkdtempSync(join(tmpdir(), 'zcc-fetch-opencode-test-'));
    roots.push(root);
    return root;
  }
  function dependencies(root: string, binary = 'opencode.exe') {
    const fetchImpl = vi.fn(async () => new Response('fake-tarball'));
    const extract = vi.fn((_command: string, args: string[]) => {
      const path = join(args[3], 'package', 'bin', binary);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, 'native-binary');
      return Buffer.alloc(0);
    });
    return { root, fetchImpl, extract };
  }

  it('stages both Mac arches and only the host Windows/Linux arch', () => {
    expect(binaryTargets('darwin', 'arm64')).toEqual([
      { arch: 'arm64', pkg: 'opencode-darwin-arm64', binary: 'opencode' },
      { arch: 'x64', pkg: 'opencode-darwin-x64', binary: 'opencode' }
    ]);
    expect(binaryTargets('win32', 'x64')).toEqual([
      { arch: 'x64', pkg: 'opencode-windows-x64', binary: 'opencode.exe' }
    ]);
    expect(binaryTargets('linux', 'arm64')).toEqual([
      { arch: 'arm64', pkg: 'opencode-linux-arm64', binary: 'opencode' }
    ]);
    expect(() => binaryTargets('freebsd', 'x64')).toThrow(/Unsupported/);
    expect(() => binaryTargets('win32', 'ia32')).toThrow(/Unsupported/);
    expect(binaryTargets()).not.toHaveLength(0);
  });

  it.each(['win32', 'darwin'])('stages the %s executable and skips only an exact cached version', async platform => {
    const target = binaryTargets(platform, 'x64')[0];
    const deps = dependencies(workspace(), target.binary);
    await fetchBinary(target, deps);
    expect(deps.fetchImpl).toHaveBeenCalledWith(
      `https://registry.npmjs.org/${target.pkg}/-/${target.pkg}-${OPENCODE_VERSION}.tgz`);
    expect(readFileSync(join(deps.root, target.arch, target.binary), 'utf8')).toBe('native-binary');
    expect(deps.extract.mock.calls[0][0]).toBe('tar');
    expect(existsSync(dirname(deps.extract.mock.calls[0][1][3]))).toBe(false);
    await fetchBinary(target, deps);
    expect(deps.fetchImpl).toHaveBeenCalledTimes(1);
    writeFileSync(join(deps.root, target.arch, '.version'), 'other-platform@old-version');
    await fetchBinary(target, deps);
    expect(deps.fetchImpl).toHaveBeenCalledTimes(2);
    rmSync(join(deps.root, target.arch, '.version'));
    await fetchBinary(target, deps);
    expect(deps.fetchImpl).toHaveBeenCalledTimes(3);
    expect(readdirSync(join(deps.root, target.arch)).sort()).toEqual(['.version', target.binary]);
  });

  it('reports HTTP failures without publishing a cached version', async () => {
    const deps = dependencies(workspace());
    deps.fetchImpl.mockResolvedValue(new Response('missing', { status: 404 }));
    await expect(fetchBinary(binaryTargets('win32', 'x64')[0], deps)).rejects.toThrow(/HTTP 404/);
    expect(deps.extract).not.toHaveBeenCalled();
    expect(readdirSync(deps.root)).toEqual([]);
  });

  it('rejects missing Windows executables and cleans extraction files', async () => {
    const deps = dependencies(workspace(), 'opencode');
    await expect(fetchBinary(binaryTargets('win32', 'x64')[0], deps)).rejects.toThrow(/package\/bin\/opencode.exe/);
    expect(existsSync(dirname(deps.extract.mock.calls[0][1][3]))).toBe(false);
    expect(readdirSync(deps.root)).toEqual([]);
  });

  it('cleans failed downloads and extraction without replacing an existing binary', async () => {
    const target = binaryTargets('win32', 'x64')[0];
    const deps = dependencies(workspace());
    await fetchBinary(target, deps);
    writeFileSync(join(deps.root, target.arch, '.version'), 'old');
    deps.extract.mockImplementationOnce(() => { throw new Error('tar failed'); });
    await expect(fetchBinary(target, deps)).rejects.toThrow('tar failed');
    expect(existsSync(dirname(deps.extract.mock.calls[1][1][3]))).toBe(false);
    expect(readFileSync(join(deps.root, target.arch, target.binary), 'utf8')).toBe('native-binary');
    expect(readFileSync(join(deps.root, target.arch, '.version'), 'utf8')).toBe('old');
    deps.fetchImpl.mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) { controller.error(new Error('download interrupted')); }
    })));
    await expect(fetchBinary(target, deps)).rejects.toThrow('download interrupted');
    expect(readdirSync(join(deps.root, target.arch)).sort()).toEqual(['.version', target.binary]);
  });
});
