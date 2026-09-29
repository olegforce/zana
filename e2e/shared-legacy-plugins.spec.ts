import { test, expect, launchApp } from './fixtures/app.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

test('shared clients show owner desktop plugins without loading their code or exposing native controls', async ({ home }) => {
  const id = 'shared-legacy-fixture', dir = join(home, '.zcc/extensions', id);
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'extension.json'), JSON.stringify({ id, title: 'Owner desktop fixture', version: '1.0.0', icon: 'Box',
    engines: { zccApi: '^1.0.0' }, entry: { renderer: 'dist/renderer.js' }, permissions: [] }));
  writeFileSync(join(dir, 'dist/renderer.js'), 'globalThis.__legacyCodeLoaded = true; export default { activate() { return {}; } };');
  const app = await launchApp(home);
  try {
    const opened = app.electron.waitForEvent('window');
    await app.electron.evaluate(({ BrowserWindow }, url) => {
      const client = new BrowserWindow({ show: false, width: 1440, height: 1000, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
      void client.loadURL(url);
    }, app.window.url());
    const browser = await opened; await browser.waitForLoadState('domcontentloaded');
    const invoke = (method: string, args: unknown[] = []) => browser.evaluate(async input => {
      const response = await fetch('/api/v1/shared-product', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
      return { status: response.status, body: await response.json() };
    }, { method, args });
    expect((await invoke('extensions.list')).body.value).toEqual(expect.arrayContaining([expect.objectContaining({ id })]));
    for (const method of ['extensions.readRendererEntry', 'extensions.grantConsent', 'extensions.setEnabled', 'modules.call']) expect((await invoke(method, [id])).status).toBe(400);
    await browser.locator('.nav-item', { hasText: 'Plugins' }).first().click();
    await browser.getByTestId('extensions-nav-installed').click();
    const row = browser.getByTestId(`plugin-row-${id}`);
    await expect(row).toContainText('Owner desktop'); await expect(row.getByRole('switch')).toHaveCount(0);
    await row.getByRole('button', { name: 'Owner desktop fixture plugin details' }).click();
    await expect(browser.getByTestId('desktop-only-plugin')).toContainText('requires the instance owner');
    expect(await browser.evaluate(() => ({ bridge: typeof window.cc, loaded: (globalThis as any).__legacyCodeLoaded }))).toEqual({ bridge: 'undefined', loaded: undefined });
    await browser.close();
  } finally { await app.electron.close(); }
});
