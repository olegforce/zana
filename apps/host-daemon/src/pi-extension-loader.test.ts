import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { piExtensionLoaderPlugin, useEmbeddedPiExtensionModules } from '../scripts/pi-extension-loader.mjs';

const source = 'isBunBinary ? { virtualModules: VIRTUAL_MODULES } : { alias: getAliases() }';

describe('packed Pi extension loader', () => {
  it('uses the embedded SDK map instead of resolving packages beside the bundle', () => {
    expect(useEmbeddedPiExtensionModules(source)).toBe(
      'isBunBinary ? { virtualModules: VIRTUAL_MODULES } : { virtualModules: VIRTUAL_MODULES, tryNative: false }'
    );
  });

  it.each(['new upstream loader', `${source}\n${source}`])('fails the build when the upstream branch changes', (input) => {
    expect(() => useEmbeddedPiExtensionModules(input)).toThrow('expected exactly one disk-alias branch');
  });

  it('only transforms the Pi extension loader and retains its dependency resolution directory', async () => {
    const onLoad = vi.fn();
    piExtensionLoaderPlugin.setup({ onLoad });
    const [{ filter }, load] = onLoad.mock.calls[0];
    expect(filter.test('/deps/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js')).toBe(true);
    expect(filter.test('C:\\deps\\@earendil-works\\pi-coding-agent\\dist\\core\\extensions\\loader.js')).toBe(true);
    expect(filter.test('/deps/another-package/dist/core/extensions/loader.js')).toBe(false);
    const root = await mkdtemp(join(tmpdir(), 'zcc-pi-loader-'));
    try {
      const path = join(root, 'loader.js');
      await writeFile(path, source);
      expect(await load({ path })).toEqual({ contents: useEmbeddedPiExtensionModules(source), loader: 'js', resolveDir: dirname(path) });
      await writeFile(path, 'changed upstream');
      await expect(load({ path })).rejects.toThrow('Pi extension loader changed');
      await expect(load({ path: join(root, 'missing.js') })).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
