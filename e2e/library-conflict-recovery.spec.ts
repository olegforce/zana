import { test, expect, launchApp } from './fixtures/app.js';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

test('browser and desktop review Library conflicts without dropping drafts or overwriting a newer revision', async ({ home }) => {
  test.setTimeout(120_000);
  const app = await launchApp(home);
  try {
    const path = join(home, 'conflict-project'); mkdirSync(path);
    const registered = await app.window.evaluate(path => window.cc.projects.add(path), path);
    if (!registered.ok) throw new Error(registered.message);
    const projectId = registered.value.id;
    await app.window.evaluate(id => window.cc.library.add({ scope: 'project', projectId: id, relPath: 'shared.md', title: 'Shared note', content: '# Original\n' }), projectId);
    const opened = app.electron.waitForEvent('window');
    await app.electron.evaluate(({ BrowserWindow }, url) => {
      const client = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
      void client.loadURL(url);
    }, app.window.url());
    const browser = await opened; await browser.waitForLoadState('domcontentloaded');
    expect(await browser.evaluate(() => typeof window.cc)).toBe('undefined');
    // DOMContentLoaded precedes product hydration and router subscription.
    // Wait for the authoritative project before dispatching a deep link.
    await expect(browser.getByRole('button', { name: 'Open conflict-project', exact: true })).toBeVisible();
    const file = join(path, '.zcc/library/shared.md');
    for (const page of [app.window, browser]) {
      await page.evaluate(id => { history.pushState({}, '', `/projects/${id}/docs`); dispatchEvent(new PopStateEvent('popstate')); }, projectId);
      await page.getByRole('button', { name: 'shared.md', exact: true }).click();
      await page.getByRole('button', { name: 'Edit', exact: true }).click();
    }
    const desktopEditor = app.window.locator('.library-viewer [contenteditable=true]');
    const browserEditor = browser.locator('.library-viewer [contenteditable=true]');
    await desktopEditor.fill('Desktop changes'); await browserEditor.fill('Browser changes');
    await browser.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => readFileSync(file, 'utf8').trim()).toBe('# Browser changes');
    await app.window.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(app.window.getByTestId('library-save-recovery')).toContainText('Your draft has been kept');
    await expect(desktopEditor).toHaveText('Desktop changes');
    await app.window.getByRole('button', { name: 'Review latest version', exact: true }).click();
    await expect(app.window.getByLabel('Latest saved version', { exact: true })).toHaveText('# Browser changes');
    // A third edit after review must still win the compare-and-swap race.
    await browser.getByRole('button', { name: 'Edit', exact: true }).click(); await browserEditor.fill('Newer browser changes');
    await browser.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => readFileSync(file, 'utf8').trim()).toBe('# Newer browser changes');
    await app.window.getByRole('button', { name: 'Save merged draft', exact: true }).click();
    await expect(app.window.getByRole('button', { name: 'Save merged draft', exact: true })).toHaveCount(0);
    await expect(desktopEditor).toHaveText('Desktop changes');
    expect(readFileSync(file, 'utf8').trim()).toBe('# Newer browser changes');
    await app.window.getByRole('button', { name: 'Review latest version', exact: true }).click();
    await expect(app.window.getByLabel('Latest saved version', { exact: true })).toHaveText('# Newer browser changes');
    await desktopEditor.fill('Desktop and newer browser changes');
    await app.window.getByRole('button', { name: 'Save merged draft', exact: true }).click();
    await expect.poll(() => readFileSync(file, 'utf8').trim()).toBe('# Desktop and newer browser changes');
    await expect(app.window.getByTestId('library-save-recovery')).toHaveCount(0);
    // The browser has an older read revision. Its recovery uses the same owner.
    await browser.getByRole('button', { name: 'Edit', exact: true }).click(); await browserEditor.fill('Unsaved browser draft');
    await browser.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(browser.getByTestId('library-save-recovery')).toBeVisible();
    await browser.getByRole('button', { name: 'Review latest version', exact: true }).click();
    await expect(browser.getByLabel('Latest saved version', { exact: true })).toHaveText('# Desktop and newer browser changes');
    await browser.getByRole('button', { name: 'Discard draft and use latest', exact: true }).click();
    await expect(browser.getByRole('heading', { name: 'Desktop and newer browser changes', exact: true })).toBeVisible();
    expect(readFileSync(file, 'utf8').trim()).toBe('# Desktop and newer browser changes');
    expect(JSON.parse(readFileSync(join(path, '.zcc/library/index.json'), 'utf8')).docs).toHaveLength(1);
    await browser.close();
  } finally { await app.electron.close(); }
});
