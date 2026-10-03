import { test, expect } from './fixtures/app.js';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

test.use({
  launchEnv: { ZCC_FAKE_PROVIDER: '1' },
  initialConfig: { sponsorPromptDismissed: true }
});

test('New Chat tips follow the real launcher without changing a draft or opening controls', async ({ app }, testInfo) => {
  const { window, home } = app;
  const binary = join(home, 'tips-claude');
  writeFileSync(binary, '#!/bin/sh\nprintf "2.1.220 (Claude Code)\\n"\n');
  chmodSync(binary, 0o755);
  await window.evaluate(async (claudeBinary) => {
    await window.cc.config.set({ claudeBinary, defaultHarness: 'claude' });
    await window.cc.harness.verify();
  }, binary);
  await window.getByTestId('nav-home').click();
  const guide = window.locator('.home-launcher-tips');
  const modes = guide.getByRole('group', { name: 'Launch mode' });
  await modes.getByRole('button', { name: 'CLI Agent', exact: true }).click();
  await guide.getByTestId('model-reasoning-picker-trigger').click();
  await window.getByTestId('model-reasoning-provider-claude-code').click();
  await guide.getByTestId('model-reasoning-picker-trigger').click();
  const editor = guide.getByTestId('legacy-agent-command-input');
  await editor.fill('Keep my launch draft');
  const dots = guide.locator('.contextual-help-tip-dot');
  await expect(dots).toHaveCount(0);
  await guide.getByRole('button', { name: /Need a few tips/ }).click();
  await expect(guide.getByRole('button', { name: 'Tip: Pick a model' })).toBeVisible();
  await expect(guide.getByRole('button', { name: 'Tip: Make the launch your own' })).toBeVisible();
  await expect(guide.getByRole('button', { name: 'Tip: You choose the access' })).toBeVisible();
  await expect(guide.getByRole('button', { name: 'Tip: Create your own plugin' })).toBeVisible();
  await expect(guide.locator('[data-tip-id="attachments"], [data-tip-id="voice"], [data-tip-id="send"]')).toHaveCount(0);
  await guide.getByRole('button', { name: 'Tip: CLI Agent', exact: true }).click();
  await expect(guide.getByRole('region')).toContainText('Open an agent in a terminal');
  await expect(modes.getByRole('button', { name: 'CLI Agent', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => guide.getByRole('region').evaluate((node) => getComputedStyle(node).opacity)).toBe('1');
  await window.screenshot({ path: testInfo.outputPath('launcher-tips-cli-agent.png') });
  await guide.getByRole('button', { name: 'Tip: Pick a model' }).click();
  await expect(guide.getByRole('region', { name: 'Launcher tip' })).toContainText('thinking effort');
  await expect(window.locator('.model-reasoning-picker-popover')).toHaveCount(0);
  await expect(editor).toHaveText('Keep my launch draft');
  await guide.getByRole('button', { name: 'Close tip' }).click();
  await expect(guide.getByRole('button', { name: 'Tip: Pick a model' })).toBeFocused();

  await modes.getByRole('button', { name: 'Modern', exact: true }).click();
  await expect(guide.getByTestId('thread-command-input')).toHaveText('Keep my launch draft');
  await expect(guide.getByRole('button', { name: 'Tip: Make the launch your own' })).toHaveCount(0);
  await expect(guide.getByRole('button', { name: 'Tip: Adjust thinking effort' })).toBeVisible();
  await expect(guide.getByRole('button', { name: 'Tip: Choose how follow-ups arrive' })).toBeVisible();
  await guide.getByRole('button', { name: 'Tip: Modern', exact: true }).click();
  await expect(guide.getByRole('region')).toContainText('Modern offers the best UX');
  await expect(guide.getByRole('region')).toContainText('accessible via mobile');
  await expect.poll(() => guide.getByRole('region').evaluate((node) => getComputedStyle(node).opacity)).toBe('1');
  await window.screenshot({ path: testInfo.outputPath('launcher-tips-modern.png') });
  await guide.getByRole('button', { name: 'Tip: Set the project' }).click();
  await expect(guide.getByRole('region')).toContainText('Use Default Project for tasks that aren’t tied to anything specific');
  await expect(guide.getByRole('region')).toContainText('recognize when your request relates to another project');

  // Measure against the rendered controls after a window resize, not a fixture map.
  await window.setViewportSize({ width: 1100, height: 850 });
  await expect.poll(async () => {
    const dot = await guide.locator('[data-tip-id="model"]').boundingBox();
    const target = await guide.getByTestId('model-reasoning-picker-trigger').boundingBox();
    return dot && target ? Math.abs(dot.x + dot.width / 2 - (target.x + target.width - 4)) : 999;
  }).toBeLessThan(2);
  await expect.poll(() => guide.getByRole('region').evaluate((node) => getComputedStyle(node).opacity)).toBe('1');
  await window.screenshot({ path: testInfo.outputPath('launcher-tips.png') });

  await modes.getByRole('button', { name: 'Squad', exact: true }).click();
  await expect(guide.getByTestId('team-command-input')).toHaveText('Keep my launch draft');
  await expect(guide.getByRole('button', { name: 'Tip: Pick a model' })).toHaveCount(0);
  await expect(guide.getByRole('button', { name: 'Tip: Choose your squad' })).toBeVisible();
  await guide.getByRole('button', { name: 'Tip: Choose your squad' }).click();
  await guide.getByRole('button', { name: 'Close tip' }).press('Escape');
  await expect(guide.getByRole('region')).toHaveCount(0);
  await guide.getByRole('button', { name: 'Tip: Choose your squad' }).press('Escape');
  await expect(dots).toHaveCount(0);
  await expect(guide.getByRole('button', { name: /Need a few tips/ })).toBeFocused();
  await expect(guide.getByTestId('team-command-input')).toHaveText('Keep my launch draft');

  await modes.getByRole('button', { name: 'Modern', exact: true }).click();
  // Electron deliberately keeps desktop controls; test its narrower supported layout.
  await window.setViewportSize({ width: 900, height: 850 });
  await guide.getByRole('button', { name: /Need a few tips/ }).click();
  await expect(guide.getByRole('button', { name: 'Tip: Pick a model' })).toBeVisible();
  const stage = (await guide.locator('.contextual-help-stage').boundingBox())!;
  for (const dot of await dots.all()) {
    const bounds = (await dot.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(stage.x - 1);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(stage.x + stage.width + 1);
  }
});
