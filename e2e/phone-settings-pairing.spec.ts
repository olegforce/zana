import { test, expect } from './fixtures/app.js';

// Even a previously configured TestFlight link must not surface the deferred app.
test.use({ launchEnv: { ZANA_MOBILE_TESTFLIGHT_URL: 'https://testflight.apple.com/join/Abcd1234' } });

test('Settings → Mobile directs users to domain setup and mobile browser access', async ({ app }, testInfo) => {
  const win = app.window;
  await win.getByRole('link', { name: 'Settings', exact: true }).click();
  await win.getByTestId('settings-nav-phone').click();
  await expect(win.getByTestId('settings-nav-phone')).toContainText('Mobile');
  const nativeApp = win.getByRole('region', { name: 'Zana mobile app' });
  await expect(nativeApp.getByText('Coming soon', { exact: true })).toBeVisible();
  const guide = win.getByRole('region', { name: 'Use Zana in your mobile browser' });
  await expect(guide.getByRole('list', { name: 'Mobile browser setup' }).getByRole('listitem')).toHaveCount(3);
  await expect(guide).toContainText('my-domain.zana-ide.com');
  await expect(guide).toContainText('same GitHub account');
  await expect(guide).toContainText('Keep this computer awake');
  const panel = win.locator('.settings-panel--preferences');
  await expect(panel.getByRole('img')).toHaveCount(0);
  await expect(panel.getByText(/TestFlight|USB|Waiting for Zana to open/)).toHaveCount(0);
  await win.screenshot({ path: testInfo.outputPath('mobile-browser-setup.png') });
  await guide.getByRole('link', { name: 'Set up my domain' }).click();
  await expect(win.getByRole('region', { name: 'Remote access setup' })).toBeVisible();
  await expect(win.getByRole('link', { name: 'Get a connect code' })).toBeVisible();
  await expect(win.getByRole('textbox', { name: 'Connect code', exact: true })).toBeVisible();
  await expect(win.getByRole('switch', { name: 'Remote access' })).toBeDisabled();
  await expect(win.getByTestId('launch-modal')).toHaveCount(0);
});
