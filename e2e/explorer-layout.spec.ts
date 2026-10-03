import { test, expect } from './fixtures/app.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

test.use({ e2e: true, initialConfig: { sponsorPromptDismissed: true } });

test('Explorer fills the project pane and its editor resizes with the tree', async ({ app, home }, testInfo) => {
  const { window } = app;
  const root = join(home, 'explorer-layout');
  mkdirSync(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'explorer-layout', description: 'A realistic long line to exercise the editor layout. '.repeat(30) }, null, 2));
  const projectId = await window.evaluate(async path => {
    const result = await window.cc.projects.add(path);
    if (!result.ok) throw new Error(result.message);
    return result.value.id;
  }, root);

  const heading = window.getByTestId('sidebar-projects-heading');
  if (await heading.getAttribute('aria-expanded') === 'false') await heading.click();
  await window.getByRole('button', { name: 'Open explorer-layout', exact: true }).click();
  await window.getByTestId('project-nav-explorer').click();
  await window.locator('.tree-row.file').filter({ hasText: 'package.json' }).click();
  const editor = window.locator('.explorer-viewer-monaco .monaco-editor');
  await expect(editor).toContainText('explorer-layout');
  await expect(window.getByRole('combobox', { name: 'Explorer machine' })).toHaveCount(0);

  for (const width of [1440, 900]) {
    await window.setViewportSize({ width, height: 850 });
    await expect.poll(async () => window.locator('.explorer-view').evaluate(surface => {
      const parent = surface.parentElement!.getBoundingClientRect();
      const grid = surface.getBoundingClientRect();
      const viewer = surface.querySelector('.explorer-viewer')!.getBoundingClientRect();
      const editor = surface.querySelector('.monaco-editor')!.getBoundingClientRect();
      return Math.max(Math.abs(parent.width - grid.width), Math.abs(parent.right - viewer.right), Math.abs(viewer.width - editor.width));
    })).toBeLessThanOrEqual(2);
    await window.screenshot({ path: testInfo.outputPath(`explorer-${width}.png`), animations: 'disabled' });
  }

  const separator = window.locator('.explorer-resizer');
  const before = await window.locator('.explorer-viewer').boundingBox();
  const handle = await separator.boundingBox();
  expect(before).toBeTruthy(); expect(handle).toBeTruthy();
  await window.mouse.move(handle!.x + handle!.width / 2, handle!.y + 80);
  await window.mouse.down();
  await window.mouse.move(handle!.x + handle!.width / 2 + 60, handle!.y + 80, { steps: 6 });
  await window.mouse.up();
  await expect.poll(async () => (await window.locator('.explorer-viewer').boundingBox())!.width).toBeCloseTo(before!.width - 60, 0);
  await separator.dblclick();
  await expect(separator).toHaveAttribute('aria-valuenow', '260');
  expect(projectId).toBeTruthy();
});
