#!/usr/bin/env node
/**
 * Post-build step for @zcc/cli.
 *
 * The esbuild bundle emits `dist/bin/zcc.js`. A shell resolving a BARE `zcc`
 * on PATH needs an executable file literally named `zcc` (no extension) —
 * the `.js` file is invisible to `command -v zcc`. In dev the npm workspace
 * symlink `node_modules/.bin/zcc` exists; in a packaged Electron app there
 * is none (electron-builder `extraResources` copies `dist/` -> `zcc-cli/`,
 * giving `resourcesPath/zcc-cli/bin/zcc.js` and, again, no bare `zcc`).
 *
 * This script emits the missing pieces INSIDE the CLI's own build so BOTH
 * dev and packaged runtimes get them:
 *
 *   1. `dist/bin/zcc` — an extensionless, executable copy of the bundled
 *      `zcc.js` (shebang + inlined workspace graph). This is the file the
 *      PATH resolver in `apps/host-daemon/src/env.ts` (`resolveZccCliBinDir`)
 *      gates on.
 *
 *   2. `dist/package.json` = `{"type":"module"}`. The bundle is ESM. In
 *      dev the parent `packages/cli/package.json` (`"type":"module"`)
 *      supplies that, but only `dist/` is copied into the packaged app, so
 *      without this marker Node would treat the `.js` file as CommonJS.
 *
 * Keeping this in the CLI package (not the Electron build) means the
 * extensionless launcher exists the moment `pnpm run build:cli` runs —
 * dev, CI, and the packaged app all go through the same path.
 */
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const distDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const binDir = join(distDir, 'bin');
const zccJs = join(binDir, 'zcc.js');

if (!existsSync(zccJs)) {
  console.error(`[postbuild] expected ${zccJs} — did esbuild run?`);
  process.exit(1);
}

const zccBare = join(binDir, 'zcc');
copyFileSync(zccJs, zccBare);
chmodSync(zccBare, 0o755);

writeFileSync(join(distDir, 'package.json'), JSON.stringify({ type: 'module' }, null, 2) + '\n');

// extraResources copies only dist/. Neither the build engine nor the SDK app
// facade may depend on the checkout's node_modules or TypeScript sources.
const runtimeModules = join(distDir, 'node_modules');
// Native build tools are fetched into the data-dir cache, like BB. Only npm's
// portable JS runtime ships; keeping it outside node_modules also avoids any
// dependency pruning performed by desktop packaging.
for (const name of ['esbuild', '@esbuild']) {
  rmSync(join(runtimeModules, name), { recursive: true, force: true });
}
const buildRequire = createRequire(join(distDir, '../../plugin-build/package.json'));
const npmRoot = dirname(buildRequire.resolve('npm/package.json'));
const runtimeDir = join(distDir, 'runtime');
rmSync(join(runtimeDir, 'npm'), { recursive: true, force: true });
cpSync(npmRoot, join(runtimeDir, 'npm'), { recursive: true, dereference: true });

const sdkRoot = join(distDir, '../../plugin-sdk');
await build({
  entryPoints: [join(sdkRoot, 'src/app.ts')],
  outfile: join(runtimeDir, 'plugin-sdk-app.js'),
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022'
});
copyFileSync(join(sdkRoot, 'bundled-types/zcc-plugin-sdk.d.ts'), join(runtimeDir, 'zcc-plugin-sdk.d.ts'));

console.log(`[postbuild] wrote ${zccBare} (0755), build runtime, and SDK facade`);
