import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { preparePluginRuntime } from './prepare-plugin-runtime.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(zcc = {}) {
  const root = mkdtempSync(join(tmpdir(), 'zcc-packaged-plugin-'));
  roots.push(root);
  const source = join(root, 'source');
  mkdirSync(source);
  writeFileSync(join(source, 'package.json'), JSON.stringify({
    name: 'zcc-plugin-runtime-fixture', version: '1.0.0', type: 'module',
    scripts: { build: 'exit 1' }, dependencies: { missing: '*' },
    zcc: { name: 'Fixture', description: 'Runtime fixture', branding: { icon: 'Puzzle' }, server: './server.mjs', ...zcc }
  }));
  writeFileSync(join(source, 'server.mjs'), 'import { value } from "./src/value.js"; export default () => value;');
  writeFileSync(join(source, 'server.ts'), 'throw new Error("undeclared source must not run");');
  mkdirSync(join(source, 'src'));
  writeFileSync(join(source, 'src/value.js'), 'export const value = 42;');
  return { root, source, output: join(root, 'runtime') };
}

it('ships declared entries, host metadata and runtime assets without source or dependencies', async () => {
  const { source, output } = fixture({ app: './app.tsx', host: './host.ts', pty: './pty.ts', skills: ['skills'], branding: { icon: './icons/fixture.svg' }, extra: { runtimeAssets: ['web'] } });
  for (const dir of ['skills', 'icons', 'web']) mkdirSync(join(source, dir));
  writeFileSync(join(source, 'skills/SKILL.md'), 'fixture skill');
  writeFileSync(join(source, 'icons/fixture.svg'), '<svg/>');
  writeFileSync(join(source, 'web/index.html'), '<p>runtime asset</p>');
  writeFileSync(join(source, 'app.tsx'), 'export default () => <div>Fixture</div>;');
  writeFileSync(join(source, 'host.ts'), 'export default { ready: true };');
  writeFileSync(join(source, 'pty.ts'), 'export default { familyId: "fixture" };');
  await preparePluginRuntime(source, output, '2.3.1');
  const pkg = JSON.parse(readFileSync(join(output, 'package.json'), 'utf8'));
  expect(pkg.zcc).toMatchObject({ server: './server.mjs', app: './app.js', host: './dist/host.js', pty: './pty.mjs' });
  expect(pkg.dependencies).toBeUndefined();
  expect(pkg.scripts).toBeUndefined();
  expect(existsSync(join(output, 'src'))).toBe(false);
  expect(existsSync(join(output, 'node_modules'))).toBe(false);
  expect(readFileSync(join(output, 'skills/SKILL.md'), 'utf8')).toBe('fixture skill');
  expect(existsSync(join(output, 'web/index.html'))).toBe(true);
  expect(JSON.parse(readFileSync(join(output, 'dist/host.meta.json'), 'utf8')).artifactDigest).toMatch(/^[a-f0-9]{64}$/);
  const runtime = await import(/* @vite-ignore */ pathToFileURL(join(output, 'server.mjs')).href);
  expect(runtime.default()).toBe(42);
  writeFileSync(join(output, 'stale.js'), 'old');
  await preparePluginRuntime(source, output, '2.3.1');
  expect(existsSync(join(output, 'stale.js'))).toBe(false);
  expect(readFileSync(join(source, 'server.mjs'), 'utf8')).toContain('./src/value.js');
});

it('handles a plugin with no optional app, host, pty or assets', async () => {
  const { source, output } = fixture();
  await preparePluginRuntime(source, output, '2.3.1');
  expect(readdirSync(output).sort()).toEqual(['package.json', 'server.meta.json', 'server.mjs']);
});

it.each(['../outside.txt', '/etc/passwd', 'web/link'])('rejects an escaping runtime asset (%s) and removes staging files', async (asset) => {
  const { root, source, output } = fixture({ extra: { runtimeAssets: [asset] } });
  writeFileSync(join(root, 'outside.txt'), 'private');
  mkdirSync(join(source, 'web'));
  symlinkSync(join(root, 'outside.txt'), join(source, 'web/link'));
  await expect(preparePluginRuntime(source, output, '2.3.1')).rejects.toThrow(/relative|escapes/);
  expect(readdirSync(root).some((name) => name.includes('.stage-'))).toBe(false);
  expect(existsSync(output)).toBe(false);
});

it('fails on unresolved imports and preserves the previous runtime', async () => {
  const { root, source, output } = fixture();
  await preparePluginRuntime(source, output, '2.3.1');
  const previous = readFileSync(join(output, 'server.mjs'), 'utf8');
  writeFileSync(join(source, 'server.mjs'), 'import "missing-build-dependency";');
  await expect(preparePluginRuntime(source, output, '2.3.1')).rejects.toThrow('Could not resolve');
  expect(readFileSync(join(output, 'server.mjs'), 'utf8')).toBe(previous);
  expect(readdirSync(root).some((name) => name.includes('.stage-'))).toBe(false);
});
