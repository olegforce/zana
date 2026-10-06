import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './fixtures/app.js';

test.use({
  launchEnv: async ({ home }, use) => {
    const bin = join(home, 'fixture-bin');
    const plugins = join(home, 'picker-plugins');
    const extensions = join(home, 'empty-extensions');
    mkdirSync(bin);
    mkdirSync(extensions);
    const buildRoot = process.env.ZCC_E2E_APP_ROOT ?? fileURLToPath(new URL('../', import.meta.url));
    cpSync(join(buildRoot, 'plugins/provider-codex'), join(plugins, 'provider-codex'), {
      recursive: true, filter: path => !path.split(sep).includes('node_modules')
    });
    const shellInit = `export PATH='${bin.replaceAll("'", "'\\''")}':"$PATH"\n`;
    for (const name of ['.zshrc', '.bashrc', '.bash_profile']) writeFileSync(join(home, name), shellInit);
    const fixture = fileURLToPath(new URL('../plugins/provider-codex/src/bridge/fake-codex-app-server.mjs', import.meta.url));
    writeFileSync(join(bin, 'codex'), `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('codex-cli 0.159.3'); process.exit(0); }
if (!process.argv.includes('app-server')) process.exit(64);
process.argv = [process.execPath, ${JSON.stringify(fixture)}];
await import(${JSON.stringify(new URL('../plugins/provider-codex/src/bridge/fake-codex-app-server.mjs', import.meta.url).href)});
`, { mode: 0o700 });
    await use({ PATH: `${bin}:${process.env.PATH ?? ''}`, ZDOTDIR: home,
      ZCC_BUNDLED_PLUGINS_DIR: plugins, ZCC_BUNDLED_EXTENSIONS_DIR: extensions,
      ZCC_MANAGED_DEV_BUILTIN_PLUGIN_HOT_RELOAD: '0' });
  }
});

test('provider picker recovers from transient absence and a plugin reload after retries are exhausted', async ({ app }) => {
  const win = app.window;
  let unavailable = true;
  let failures = 0;
  const failuresByScope = new Map<string, number>();
  let recoverAfterFirstFailure = true;
  await win.route('**/api/v1/system/execution-options?*', async route => {
    const url = new URL(route.request().url());
    if (!unavailable || !url.searchParams.getAll('providerId').includes('codex')) return route.continue();
    failures += 1;
    const scope = JSON.stringify([url.searchParams.get('hostId'), url.searchParams.get('projectId')]);
    failuresByScope.set(scope, (failuresByScope.get(scope) ?? 0) + 1);
    const options = {
      providers: [{ id: 'codex', displayName: 'Codex', available: true, composerActions: [], capabilities: { permissionModes: ['full'] } }],
      permissionCeiling: 'full', models: [], selectedOnlyModels: [],
      modelLoadError: { providerId: 'codex', code: 'provider_unavailable', detail: null }
    };
    await route.fulfill({ status: 200, contentType: url.searchParams.get('stream') === '1' ? 'application/x-ndjson' : 'application/json',
      body: JSON.stringify(url.searchParams.get('stream') === '1' ? { providerId: 'codex', options } : options) + '\n' });
    if (recoverAfterFirstFailure) unavailable = false;
  });
  await win.reload();
  const trigger = win.getByTestId('model-reasoning-picker-trigger');
  await expect(trigger).toContainText('Provider unavailable');
  await expect(trigger).toContainText('Fake model', { timeout: 20_000 });
  expect(failures).toBeGreaterThan(0);

  // Exhaust the bounded retries, then use the real plugin lifecycle and push.
  unavailable = true;
  recoverAfterFirstFailure = false;
  failures = 0;
  failuresByScope.clear();
  await win.reload();
  await expect(trigger).toContainText('Provider unavailable');
  await expect.poll(() => Math.max(0, ...failuresByScope.values()), { timeout: 30_000 }).toBe(4);
  unavailable = false;
  expect(await win.evaluate(() => window.cc.pluginApps.reload('provider-codex'))).toEqual({ ok: true, value: true });
  await expect(trigger).toContainText('Fake model', { timeout: 10_000 });
  await trigger.click();
  await expect(win.getByRole('button', { name: 'Fake model', exact: true })).toBeVisible();
  await expect(win.getByTestId('model-reasoning-picker-menu')).not.toContainText('Provider unavailable');
});
