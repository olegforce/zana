import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readPluginManifest } from '@zana-ai/zcc-domain';
import { bundlePluginEntry, createPluginArtifactMeta, writePluginArtifactMeta } from './build-plugin.js';
import { buildPluginHost } from './build-plugin-host.js';

/** Produce a dependency-free release tree; never ship editable entry points. */
export async function preparePluginRuntime(rootDir: string, outputDir: string, zccVersion: string): Promise<void> {
  const root = realpathSync(rootDir);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const manifest = readPluginManifest(pkg);
  const stage = `${outputDir}.stage-${randomUUID()}`;
  const contained = (path: string): string => {
    if (isAbsolute(path)) throw new Error(`Runtime asset must be relative: ${path}`);
    const full = realpathSync(resolve(root, path));
    if (!full.startsWith(root + sep)) throw new Error(`Runtime asset escapes plugin: ${path}`);
    return full;
  };
  mkdirSync(stage, { recursive: true });
  try {
    const zcc = { ...pkg.zcc };
    for (const [kind, entry, file] of [
      ['server', manifest.serverEntry, 'server.mjs'],
      ['app', manifest.appEntry, 'app.js'],
      ['pty', manifest.ptyEntry, 'pty.mjs']
    ] as const) {
      if (!entry) continue;
      // Honor the declared entry: a sibling TypeScript file may be an older
      // implementation, not the source of a handwritten JavaScript entry.
      await bundlePluginEntry({ entry: contained(entry), outfile: join(stage, file), platform: kind === 'app' ? 'browser' : 'node', bundleSdk: true });
      zcc[kind] = `./${file}`;
      writePluginArtifactMeta(join(stage, `${kind}.meta.json`), createPluginArtifactMeta({
        packageName: pkg.name, pluginVersion: pkg.version, zccVersion
      }));
    }
    if (manifest.hostEntry) {
      await buildPluginHost(root, zccVersion);
      mkdirSync(join(stage, 'dist'), { recursive: true });
      for (const file of ['host.js', 'host.meta.json']) cpSync(join(root, 'dist', file), join(stage, 'dist', file));
      zcc.host = './dist/host.js';
    }
    const assets = new Set<string>([
      ...manifest.skillsRootPaths.filter((path) => existsSync(join(root, path))),
      ...(existsSync(join(root, 'icons')) ? ['icons'] : []),
      ...Object.values(pkg.zcc.branding ?? {}).filter((value): value is string => typeof value === 'string' && value.startsWith('.')),
      ...(pkg.zcc.extra?.runtimeAssets ?? [])
    ]);
    for (const asset of assets) {
      const source = contained(asset);
      const destination = join(stage, relative(root, source));
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(source, destination, { recursive: true, filter: (path) => {
        if (lstatSync(path).isSymbolicLink()) throw new Error(`Runtime asset contains symlink: ${path}`);
        return true;
      } });
    }
    // Scripts/dependencies/exports describe the source package and must not
    // invite installation or compilation on an end user's machine.
    const { scripts, dependencies, devDependencies, exports, ...runtimePkg } = pkg;
    writeFileSync(join(stage, 'package.json'), `${JSON.stringify({ ...runtimePkg, zcc }, null, 2)}\n`);
    rmSync(outputDir, { recursive: true, force: true });
    renameSync(stage, outputDir);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
