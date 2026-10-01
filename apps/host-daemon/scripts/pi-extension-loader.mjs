import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Pi's Node loader expects dist files + node_modules; our bridge is one file. */
export function useEmbeddedPiExtensionModules(source) {
  const diskAliases = ': { alias: getAliases() }';
  if (source.split(diskAliases).length !== 2) {
    throw new Error('Pi extension loader changed: expected exactly one disk-alias branch');
  }
  return source.replace(diskAliases, ': { virtualModules: VIRTUAL_MODULES, tryNative: false }');
}

/** Use Pi's own bundled SDK/TypeBox exports without changing its runtime identity. */
export const piExtensionLoaderPlugin = {
  name: 'embedded-pi-extension-modules',
  setup(build) {
    build.onLoad({ filter: /[/\\]@earendil-works[/\\]pi-coding-agent[/\\]dist[/\\]core[/\\]extensions[/\\]loader\.js$/ }, async ({ path }) => ({
      contents: useEmbeddedPiExtensionModules(await readFile(path, 'utf8')),
      loader: 'js',
      resolveDir: dirname(path)
    }));
  }
};
