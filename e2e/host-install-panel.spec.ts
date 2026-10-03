import type { Route } from '@playwright/test';
import { test, expect } from './fixtures/app.js';

test.use({ isolateBundledCatalog: true });

test('remote daemon installation uses the notification panel styling with bounded logs and readable errors', async ({ app }, testInfo) => {
  const win = app.window;
  const target = 'sfwork@remote-machine-with-a-long-name.example.invalid';
  const error = `${target}: Permission denied (publickey,gssapi-keyex,gssapi-with-mic).`;
  const command = 'ssh remote-machine zcc-host join';
  await win.route('**/api/v1/hosts', route => route.fulfill({ json: [{
    id: 'install-fixture', name: target, type: 'persistent', status: 'disconnected',
    maxPermissionMode: 'full', isPrimary: false, canRepairViaSsh: true,
    lastSeenAt: null, lastRejectedProtocolVersion: null, createdAt: 1, updatedAt: 1
  }] }));
  await win.route('**/api/v1/relay/renew-join', route => route.fulfill({ json: {} }));
  let reply: Route | undefined;
  await win.route('**/api/v1/hosts/install-fixture/repair', route => { reply = route; });
  await win.goto(`${new URL(win.url()).origin}/settings/machines`);
  const reconnect = win.getByTestId('machine-reconnect-install-fixture');
  await reconnect.click();
  const panel = win.getByTestId('host-install-drawer');
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('status')).toHaveText('Reconnecting…');
  await expect.poll(() => Boolean(reply)).toBe(true);
  await reply!.fulfill({ contentType: 'application/x-ndjson', body: [
    { type: 'log', text: 'Checking the remote host daemon…\nRestart did not reconnect; reinstalling…\nInstalling host daemon over SSH…' },
    { type: 'error', message: error, pairingCommand: command }
  ].map(event => JSON.stringify(event)).join('\n') + '\n' });
  await expect(panel.getByRole('status')).toHaveText('Install failed');
  await expect(panel.getByRole('alert')).toHaveText(error);
  await expect(panel.getByTestId('host-install-log')).toContainText('Installing host daemon over SSH…');
  await expect(panel.getByTestId('host-install-copy-command')).toBeVisible();

  // Compare actual computed chrome so a legacy full-height drawer cannot pass.
  await win.locator('.titlebar-bell').click();
  const notifications = win.locator('.quick-access-panel.notifications-drawer');
  await expect(notifications).toBeVisible();
  const chrome = (selector: string) => win.locator(selector).evaluate(element => {
    const style = getComputedStyle(element);
    return { width: style.width, right: style.right, top: style.top, radius: style.borderRadius, shadow: style.boxShadow };
  });
  expect(await chrome('.host-install-drawer')).toEqual(await chrome('.quick-access-panel.notifications-drawer'));
  await win.locator('.titlebar-bell').click();
  await expect(notifications).toHaveCount(0);

  for (const theme of ['light', 'dark'] as const) {
    await win.evaluate(value => window.cc.config.set({ theme: value }), theme);
    await expect(win.locator('html')).toHaveAttribute('data-theme', theme);
    expect(await panel.evaluate(element => element.getBoundingClientRect().height < 500)).toBe(true);
    expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await win.screenshot({ path: testInfo.outputPath(`host-install-${theme}.png`), animations: 'disabled' });
  }
  await win.setViewportSize({ width: 360, height: 480 });
  await expect.poll(() => panel.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return bounds.x >= 0 && bounds.right <= window.innerWidth && bounds.bottom <= window.innerHeight;
  })).toBe(true);
  await expect(panel.getByRole('button', { name: 'Copy install command' })).toBeInViewport();
  await win.screenshot({ path: testInfo.outputPath('host-install-narrow.png'), animations: 'disabled' });
  await panel.getByRole('button', { name: 'Close install log' }).press('Escape');
  await expect(panel).toHaveCount(0);

  await win.setViewportSize({ width: 1280, height: 900 });
  reply = undefined;
  await reconnect.click();
  await expect.poll(() => Boolean(reply)).toBe(true);
  await reply!.fulfill({ contentType: 'application/x-ndjson', body: [
    { type: 'log', text: Array.from({ length: 400 }, (_, i) => `Install output ${i}`).join('\n') },
    { type: 'error', message: error }
  ].map(event => JSON.stringify(event)).join('\n') + '\n' });
  const log = panel.getByTestId('host-install-log');
  await expect(panel.getByRole('status')).toHaveText('Install failed');
  expect(await log.evaluate(element => element.scrollHeight > element.clientHeight && element.clientHeight <= 320)).toBe(true);
  await expect.poll(() => log.evaluate(element => Math.abs(element.scrollHeight - element.scrollTop - element.clientHeight) <= 1)).toBe(true);
  await panel.getByRole('button', { name: 'Close install log' }).click();
  await expect(panel).toHaveCount(0);

  reply = undefined;
  await reconnect.click();
  await expect.poll(() => Boolean(reply)).toBe(true);
  await reply!.fulfill({ contentType: 'application/x-ndjson', body: JSON.stringify({ type: 'done', hostId: 'install-fixture' }) + '\n' });
  await expect(panel.getByRole('status')).toHaveText('Reconnected');
  await expect(panel).toHaveCount(0);
});
