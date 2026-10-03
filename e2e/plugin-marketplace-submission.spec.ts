import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, launchApp } from './fixtures/app.js';

test('direct plugin actions prepare a marketplace submission draft in built Electron', async ({ home }) => {
  const pluginsDir = join(home, '.zcc', 'plugins');
  mkdirSync(pluginsDir, { recursive: true });
  const plugins = ['direct', 'catalog'].map((provenance) => {
    const id = `submission-${provenance}`;
    const rootDir = join(home, `zcc-plugin-${id}`);
    mkdirSync(rootDir, { recursive: true });
    writeFileSync(join(rootDir, 'package.json'), JSON.stringify({
      name: `zcc-plugin-${id}`, version: '0.1.0', type: 'module',
      engines: { zcc: '>=1.0.0', zccPluginSdk: '>=0.1.0' },
      zcc: { name: `Submission ${provenance}`, description: 'Submission fixture', server: './server.mjs' }
    }));
    writeFileSync(join(rootDir, 'server.mjs'), 'export default function () {}');
    return {
      id, rootDir, version: '0.1.0', name: `Submission ${provenance}`, description: 'Submission fixture', icon: 'Puzzle',
      enabled: false, status: 'disabled', statusDetail: null, provenance, sourceKind: 'path', source: `path:${rootDir}`,
      serverEntry: './server.mjs', appEntry: null, installedAt: 1, updatedAt: 1,
      npmResolvedVersion: null, npmIntegrity: null, gitResolvedCommit: null, catalogMarketplace: null, catalogEntryId: null
    };
  });
  writeFileSync(join(pluginsDir, 'installed.json'), JSON.stringify({ version: 1, plugins }));
  const app = await launchApp(home, { initialConfig: { sponsorPromptDismissed: true } });
  try {
    const win = app.window;
    const launches: string[] = [];
    win.on('request', (request) => {
      if (request.method() === 'POST' && /\/api\/v1\/threads(?:\?|$)/.test(request.url())) launches.push(request.url());
    });
    await win.locator('.nav-item', { hasText: 'Plugins' }).first().click();
    await win.getByTestId('extensions-nav-installed').click();
    await win.getByLabel('Search installed plugins').fill('Submission catalog');
    await win.getByTestId('plugin-row-submission-catalog').getByRole('button', { name: 'Submission catalog plugin details' }).click();
    await win.getByRole('button', { name: 'More plugin actions' }).click();
    await expect(win.getByRole('menuitem', { name: 'Submit to marketplace' })).toHaveCount(0);
    await expect(win.getByRole('menuitem', { name: 'Uninstall', exact: true })).toBeVisible();

    await win.getByTestId('extensions-nav-installed').click();
    await win.getByLabel('Search installed plugins').fill('Submission direct');
    await win.getByTestId('plugin-row-submission-direct').getByRole('button', { name: 'Submission direct plugin details' }).click();
    await win.getByRole('button', { name: 'More plugin actions' }).click();
    await win.getByRole('menuitem', { name: 'Submit to marketplace' }).click();
    const prompt = win.locator('.home-agent-composer, .thread-command-composer, .new-thread-view').first()
      .locator('.ProseMirror, [contenteditable="true"]').first();
    await expect(prompt).toContainText('Use the submit-a-plugin skill');
    await expect(prompt).toContainText('"id":"submission-direct"');
    await expect(prompt).toContainText('"name":"Submission direct"');
    await expect(prompt).toContainText('public or internal visibility');
    await expect(prompt).toContainText('approval of release changes');
    expect(launches).toEqual([]);
    const snapshot = await win.evaluate(async () => (await fetch('/api/v1/plugin-apps').then((r) => r.json())).apps);
    const installed = snapshot.find((plugin: { id: string }) => plugin.id === 'submission-direct');
    expect(installed).toMatchObject({ enabled: false, provenance: 'direct', status: 'disabled' });
    expect(installed).not.toHaveProperty('source');
    expect(installed).not.toHaveProperty('rootDir');
  } finally {
    await app.electron.close();
  }
});
