import { test, expect } from './fixtures/app.js';

test('AI Harness makes setup readable and preserves keyboard, enablement, and binary settings', async ({ app }, testInfo) => {
  const win = app.window;
  await win.getByRole('link', { name: 'Settings', exact: true }).click();
  await win.getByTestId('settings-nav-harness').click();
  const panel = win.locator('.harness-settings');
  const status = panel.getByTestId('harness-status-list');
  await expect(status.locator('.opener-row').first()).toBeVisible();
  const statusBox = (await status.boundingBox())!;
  const modelsBox = (await panel.locator('#settings-anchor-harness-models').boundingBox())!;
  expect(statusBox.y + statusBox.height).toBeLessThan(modelsBox.y);
  await expect(panel.locator('.harness-machine-name')).toContainText('This machine');
  await expect(status).toContainText('Always on');

  await expect(panel.getByRole('button', { name: 'Check status', exact: true })).toBeEnabled({ timeout: 30_000 });
  const codex = status.getByRole('switch', { name: 'Show Codex in the New Agent modal' });
  const enabled = await codex.getAttribute('aria-checked') === 'true';
  await codex.click();
  await expect(codex).toHaveAttribute('aria-checked', String(!enabled));
  await expect.poll(() => win.evaluate(() => window.cc.config.get())).toMatchObject({ harnessCodexEnabled: !enabled });
  await codex.click();
  await expect(codex).toHaveAttribute('aria-checked', String(enabled));

  const modern = panel.getByRole('tab', { name: 'Modern', exact: true });
  const cli = panel.getByRole('tab', { name: 'CLI Agent', exact: true });
  await modern.focus();
  await modern.press('ArrowRight');
  await expect(cli).toBeFocused();
  await expect(panel.getByRole('tabpanel', { name: 'CLI Agent' })).toBeVisible();
  const claudeSettings = panel.getByRole('button', { name: 'Advanced settings for Claude Code' });
  await claudeSettings.click();
  await expect(claudeSettings).toHaveAttribute('aria-expanded', 'true');
  await expect(panel.getByRole('group', { name: 'Instructions', exact: true })).toBeVisible();
  await expect(panel.getByRole('group', { name: 'Tools & access', exact: true })).toBeVisible();
  await expect(panel.getByRole('group', { name: 'Connection', exact: true })).toBeVisible();
  const prompt = panel.getByRole('textbox', { name: 'Append system prompt' });
  await prompt.fill('Keep responses concise.');
  await prompt.press('Tab');
  await expect.poll(() => win.evaluate(() => window.cc.config.get())).toMatchObject({ claudeAppendSystemPrompt: 'Keep responses concise.' });
  const binary = panel.getByRole('textbox', { name: 'Claude Code binary' });
  await binary.fill('claude');
  await binary.press('Tab');
  await expect.poll(() => win.evaluate(() => window.cc.config.get())).toMatchObject({ claudeBinary: 'claude' });
  await claudeSettings.click();
  await expect(binary).toBeHidden();
  await cli.press('Home');
  await expect(modern).toBeFocused();
  const modernPanel = panel.getByRole('tabpanel', { name: 'Modern' });
  await expect(modernPanel).toBeVisible();
  const provider = modernPanel.getByRole('button', { name: 'Models for Codex', exact: true });
  await expect(provider).toBeVisible();
  await expect(modernPanel.locator('.thread-provider-id')).toHaveCount(0);
  await provider.click();
  await expect(modernPanel.locator('.thread-provider-id')).toHaveText('provider-codex');
  const search = modernPanel.getByRole('searchbox', { name: 'Search Codex models' });
  await expect(search).toBeVisible({ timeout: 30_000 });
  const modelId = await modernPanel.locator('.thread-provider-models code').first().innerText();
  await search.fill(modelId);
  await expect(modernPanel.locator('.thread-provider-models')).toContainText(modelId);
  await search.fill('does-not-exist-in-catalogue');
  await expect(modernPanel.getByText('No models match your search.')).toBeVisible();
  await search.fill('');
  await provider.click();

  async function captureModels(name: string) {
    // Config updates (including theme changes) invalidate the shared catalogue.
    const reload = modernPanel.getByRole('button', { name: /^(Load|Reload)$/ });
    await expect(reload).toBeEnabled({ timeout: 30_000 });
    await reload.click();
    await expect(search).toBeVisible({ timeout: 30_000 });
    await provider.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await win.screenshot({ path: testInfo.outputPath(name), animations: 'disabled' });
  }

  for (const theme of ['light', 'dark'] as const) {
    await win.evaluate((theme) => window.cc.config.set({ theme }), theme);
    await expect(win.locator('html')).toHaveAttribute('data-theme', theme);
    await win.locator('.settings-panel').evaluate((el) => { el.scrollTop = 0; });
    await win.screenshot({ path: testInfo.outputPath(`harness-${theme}.png`), animations: 'disabled' });
    await win.locator('#settings-anchor-harness-thread').scrollIntoViewIfNeeded();
    await win.screenshot({ path: testInfo.outputPath(`harness-models-${theme}.png`), animations: 'disabled' });
    await provider.click();
    await captureModels(`thread-options-${theme}.png`);
    await provider.click();
    await cli.click();
    await claudeSettings.click();
    await claudeSettings.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await win.screenshot({ path: testInfo.outputPath(`cli-options-${theme}.png`), animations: 'disabled' });
    await panel.getByRole('group', { name: 'Tools & access', exact: true }).evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await win.screenshot({ path: testInfo.outputPath(`cli-tools-${theme}.png`), animations: 'disabled' });
    await panel.locator('.harness-default-card').screenshot({ path: testInfo.outputPath(`cli-default-${theme}.png`), animations: 'disabled' });
    await claudeSettings.click();
    await modern.click();
  }

  await win.setViewportSize({ width: 800, height: 800 });
  const settingsPanel = win.locator('.settings-panel');
  const overflow = await settingsPanel.evaluate((el) => [...el.querySelectorAll('*')].filter((node) => node.getBoundingClientRect().right > el.getBoundingClientRect().right + 1).slice(0, 12).map((node) => ({ className: node.className, width: node.getBoundingClientRect().width })));
  await expect.poll(() => settingsPanel.evaluate((el) => el.scrollWidth <= el.clientWidth), { message: JSON.stringify(overflow) }).toBe(true);
  await settingsPanel.evaluate((el) => { el.scrollTop = 0; });
  await win.screenshot({ path: testInfo.outputPath('harness-narrow.png'), animations: 'disabled' });
  await cli.click();
  await claudeSettings.click();
  await expect(binary).toHaveValue('claude');
  await expect.poll(() => settingsPanel.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await claudeSettings.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await win.screenshot({ path: testInfo.outputPath('cli-options-narrow.png'), animations: 'disabled' });
  await modern.click();
  await provider.click();
  await captureModels('thread-options-narrow.png');
  await expect.poll(() => settingsPanel.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
});
