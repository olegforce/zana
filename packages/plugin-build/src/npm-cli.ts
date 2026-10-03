import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** npm's JS entry travels with the CLI; it never depends on the shell's PATH. */
export function resolveBundledNpmCli(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = [
    join(here, '../runtime/npm/bin/npm-cli.js'),
    ...(resources ? [join(resources, 'zcc-cli/runtime/npm/bin/npm-cli.js')] : []),
    join(here, '../../packages/cli/dist/runtime/npm/bin/npm-cli.js'),
    join(here, '../../../packages/cli/dist/runtime/npm/bin/npm-cli.js')
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve('npm/package.json')), 'bin/npm-cli.js');
}
