import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);

/** Runs the actual shipped CLI, with no checkout dependencies or user's data. */
export async function verifyPackagedPluginBuild(cli) {
  const root = await mkdtemp(join(tmpdir(), 'zcc-packaged-toolchain-'));
  try {
    const plugin = join(root, 'plugin');
    await mkdir(plugin);
    await writeFile(join(root, '.npmrc'), '');
    await writeFile(join(plugin, 'package.json'), JSON.stringify({
      name: 'zcc-plugin-release-probe', version: '0.1.0', type: 'module',
      zcc: { name: 'Release probe', server: './server.ts', app: './app.tsx', host: './host.ts' }
    }));
    await writeFile(join(plugin, 'server.ts'), 'export default () => {};\n');
    await writeFile(join(plugin, 'host.ts'), 'export default { releaseHost: true };\n');
    await writeFile(join(plugin, 'app.tsx'), [
      'import { definePluginApp } from "@zana-ai/zcc-plugin-sdk/app";',
      'export default definePluginApp(app => app.slots.navPanel({id:"main",title:"Release probe",icon:"Cloud",component:()=>null}));'
    ].join('\n'));
    const env = { ...process.env, HOME: root, USERPROFILE: root, ZCC_DATA_DIR: join(root, 'data'),
      NODE_PATH: '', ESBUILD_BINARY_PATH: '', npm_config_userconfig: join(root, '.npmrc'),
      npm_config_registry: 'https://registry.npmjs.org/' };
    // A release gate cannot accidentally attach to the maintainer's session.
    delete env.ZCC_SESSION_ID; delete env.ZCC_SESSION_TOKEN;
    delete env.ELECTRON_RUN_AS_NODE;
    await run(process.execPath, [cli, 'plugin', 'build', plugin], { cwd: plugin, env, timeout: 150_000, maxBuffer: 2 * 1024 * 1024 });
    const app = await readFile(join(plugin, 'app.js'), 'utf8');
    const host = await readFile(join(plugin, 'dist/host.js'), 'utf8');
    if (!app.includes('navPanel') || !host.includes('releaseHost')) throw new Error('packaged plugin bundles are incomplete');
    // Delete generated output, retain only the durable toolchain and block fetch.
    await rm(join(plugin, 'app.js'));
    await run(process.execPath, [cli, 'plugin', 'build', plugin], {
      cwd: plugin, env: { ...env, npm_config_registry: 'http://127.0.0.1:9', npm_config_fetch_retries: '0' },
      timeout: 30_000, maxBuffer: 2 * 1024 * 1024
    });
    if (!((await readFile(join(plugin, 'app.js'), 'utf8')).includes('navPanel'))) throw new Error('offline cached plugin build failed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: node scripts/verify-packaged-plugin-build.mjs <shipped zcc CLI>');
  await verifyPackagedPluginBuild(resolve(process.argv[2]));
  console.log('Packaged plugin builds passed: cold bootstrap and offline cache.');
}
