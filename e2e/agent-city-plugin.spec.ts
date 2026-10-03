import { createServer } from 'node:net';
import { chromium } from '@playwright/test';
import { startMobileGateway } from '../apps/server/src/mobile/gateway.js';
import { execFile } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { test, expect } from './fixtures/app.js';

const exec = promisify(execFile);
test.use({ initialConfig: { sponsorPromptDismissed: true }, launchEnv: { ZCC_FAKE_PROVIDER: '1' } });

test('Agent City adds the fourth Agents view, opens real work, reloads and falls back on disable', async ({ app, home }, testInfo) => {
  test.setTimeout(180_000);
  const source = join(home, 'agent-city');
  cpSync(resolve('plugins/agent-city'), source, { recursive: true, filter: (path) => !path.includes('node_modules') });
  const copiedCli = join(home, 'cli');
  cpSync(resolve('packages/cli/dist'), copiedCli, { recursive: true, dereference: true });
  const env = { ...process.env, HOME: home, ZCC_DATA_DIR: join(home, '.zcc'), ZCC_SERVER_URL: new URL(app.window.url()).origin,
    ZCC_SESSION_ID: undefined, ZCC_SESSION_TOKEN: undefined, ZCC_SKIP_PLUGIN_NPM: '1', NODE_PATH: '', ESBUILD_BINARY_PATH: '' };
  async function run(args: string[]) {
    return exec(process.execPath, [join(copiedCli, 'bin/zcc'), ...args], { cwd: source, env, timeout: 60_000, maxBuffer: 1024 * 1024 });
  }
  const root = join(home, 'city-project'); mkdirSync(root);
  const seed = await app.window.evaluate(async (path) => {
    const projectResponse = await fetch('/api/v1/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });
    if (!projectResponse.ok) throw new Error(await projectResponse.text());
    const { project } = await projectResponse.json();
    const response = await fetch('/api/v1/threads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: project.id, providerId: 'fake', title: 'City live agent', input: 'Hello' }) });
    if (!response.ok) throw new Error(await response.text());
    const { thread } = await response.json();
    return { projectId: project.id, threadId: thread.id };
  }, root);
  const additionalRoots = Array.from({ length: 9 }, (_, i) => join(home, `city-neighbor-${i + 1}`));
  for (const path of additionalRoots) mkdirSync(path);
  await app.window.evaluate(async (paths) => {
    for (const path of paths) {
      const response = await fetch('/api/v1/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });
      if (!response.ok) throw new Error(await response.text());
    }
  }, additionalRoots);
  const errors: string[] = [];
  app.window.on('pageerror', (error) => errors.push(error.message));
  await run(['plugin', 'install', '.']);
  const navigate = async (path: string) => app.window.evaluate((url) => { history.pushState({}, '', url); dispatchEvent(new PopStateEvent('popstate')); }, path);
  await navigate('/extensions/plugins');
  await expect(app.window.locator('a[href*="/extensions/pages/agent-city/"]')).toHaveCount(0);
  await navigate('/agents');
  const toggle = app.window.getByRole('group', { name: 'Agents view', exact: true }).filter({ visible: true });
  await expect(toggle.getByRole('button')).toHaveCount(4);
  await expect(toggle.getByRole('button').nth(3)).toHaveAccessibleName('World view');
  await toggle.getByRole('button', { name: 'World view' }).click();
  const city = app.window.getByTestId('agent-city');
  await expect(city).toBeVisible();
  await expect(city.getByRole('button', { name: /district/i })).toHaveCount(0);
  const map = city.locator('.city-world');
  await expect(city).toHaveCSS('border-radius', '0px');
  await expect(map).toHaveCSS('border-radius', '0px');
  async function expectBuildingsInsideMap() {
    const bounds = await map.boundingBox();
    expect(bounds).not.toBeNull();
    for (const label of await city.locator('.city-label').all()) {
      const box = await label.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(bounds!.x);
      expect(box!.y).toBeGreaterThanOrEqual(bounds!.y);
      expect(box!.x + box!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width);
      expect(box!.y + box!.height).toBeLessThanOrEqual(bounds!.y + bounds!.height);
    }
  }
  for (let i = 1; i <= 9; i++) await expect(city.getByRole('button', { name: new RegExp(`city-neighbor-${i}, 0 live`) })).toBeInViewport();
  await expectBuildingsInsideMap();
  await city.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(city.getByLabel('Map zoom level')).toHaveText('125%');
  const mapBounds = (await map.boundingBox())!;
  await app.window.mouse.move(mapBounds.x + 25, mapBounds.y + 80);
  await app.window.mouse.down();
  await app.window.mouse.move(mapBounds.x + 100, mapBounds.y + 100, { steps: 5 });
  await app.window.mouse.up();
  await expect(map).toHaveAttribute('data-dragging', 'false');
  await expect(city.getByRole('complementary')).toHaveCount(0);
  await city.getByRole('button', { name: 'Fit city', exact: true }).click();
  await expect(city.getByLabel('Map zoom level')).toHaveText('100%');
  await expectBuildingsInsideMap();
  const arrival = join(home, 'city-new-arrival'); mkdirSync(arrival);
  await app.window.evaluate(async (path) => {
    const response = await fetch('/api/v1/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });
    if (!response.ok) throw new Error(await response.text());
  }, arrival);
  await expect(city.getByRole('button', { name: /city-new-arrival, 0 live/ })).toBeInViewport();
  await expectBuildingsInsideMap();
  await app.window.screenshot({ path: testInfo.outputPath('city-continuous.png') });
  await city.getByLabel('Find a project building').selectOption(seed.projectId);
  await expect(city.getByRole('button', { name: /City live agent/ })).toBeVisible();
  await expect(city.getByRole('button', { name: /city-project, 1 live agents/ })).toBeVisible();
  await city.getByRole('button', { name: 'Pause motion' }).click();
  await expect(city.getByRole('button', { name: 'Resume motion' })).toHaveAttribute('aria-pressed', 'true');
  await app.window.screenshot({ path: testInfo.outputPath('city-desktop.png') });
  await city.getByRole('button', { name: /City live agent/ }).click();
  const inspector = app.window.getByRole('dialog', { name: 'City live agent', exact: true });
  await expect(inspector).toBeVisible();
  await inspector.getByRole('button', { name: 'Close', exact: true }).click();
  await navigate('/agents');
  await expect(city).toBeVisible();
  await app.window.reload();
  await expect(city).toBeVisible();
  await city.getByRole('button', { name: /Scheduler station/ }).click();
  await expect(city.getByRole('heading', { name: 'Scheduler station' })).toBeVisible();
  // Live reload proves the host drops the old generation and mounts the rebuilt plugin.
  const appPath = join(source, 'city-app.tsx');
  writeFileSync(appPath, readFileSync(appPath, 'utf8').replace('Your agents, a little more alive.', 'City reload verified'));
  await run(['plugin', 'dev', '--once']);
  await expect(city.getByRole('heading', { name: 'City reload verified' })).toBeVisible();
  await app.window.bringToFront();
  await app.window.emulateMedia({ reducedMotion: 'reduce' });
  await app.window.reload();
  await expect(city.getByRole('button', { name: 'Reduced motion' })).toBeDisabled();
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const serverUrl = `http://127.0.0.1:${port}`;
  const gateway = await startMobileGateway({ upstream: new URL(app.window.url()).origin, publicUrl: serverUrl, port });
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
    const paired = await context.request.post(`${serverUrl}/_mobile/pair`, { data: { code: gateway.pair().code, label: 'City E2E' } });
    const credential = await paired.json();
    expect((await context.request.post(`${serverUrl}/_mobile/session`, { headers: { authorization: `Bearer ${credential.credential}` } })).ok()).toBe(true);
    const phone = await context.newPage();
    await phone.goto(serverUrl + '/agents');
    await phone.getByRole('button', { name: 'Agents actions', exact: true }).click();
    await phone.getByRole('button', { name: 'World view', exact: true }).filter({ visible: true }).click();
    await expect(phone.getByTestId('agent-city')).toBeVisible();
    await expect(phone.getByRole('button', { name: 'Reduced motion' })).toBeDisabled();
    await phone.emulateMedia({ reducedMotion: 'no-preference' });
    await expect(phone.getByRole('button', { name: 'Pause motion' })).toBeEnabled();
    await phone.emulateMedia({ reducedMotion: 'reduce' });
    await expect(phone.getByRole('button', { name: 'Reduced motion' })).toBeDisabled();
    for (const width of [320, 390, 820]) {
      await phone.setViewportSize({ width, height: 844 });
      expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await phone.screenshot({ path: testInfo.outputPath(`city-mobile-${width}.png`) });
    }
  } finally {
    await browser.close();
    await gateway.close();
  }
  await run(['plugin', 'disable', 'agent-city']);
  await expect(city).toHaveCount(0);
  await expect(app.window.getByRole('button', { name: 'World view', exact: true })).toHaveCount(0);
  await expect(app.window.getByRole('button', { name: 'Board view', exact: true }).filter({ visible: true })).toHaveAttribute('aria-pressed', 'true');
  await run(['plugin', 'enable', 'agent-city']);
  await expect(city).toBeVisible();
  // The guide's selector marker must open the new API documentation in the built host.
  const guideSource = join(home, 'plugin-guide');
  cpSync(resolve('plugins/plugin-guide'), guideSource, { recursive: true, filter: (path) => !path.includes('node_modules') });
  await run(['plugin', 'install', guideSource]);
  await navigate('/extensions/pages/plugin-guide/plugin-guide/project-shell');
  const viewMarker = app.window.locator('a[data-guide-region="experimental_agentsView"]').filter({ visible: true });
  await expect(viewMarker).toBeVisible();
  await viewMarker.click();
  const guideCard = app.window.getByRole('dialog', { name: 'Agents view', exact: true });
  await expect(guideCard).toBeVisible();
  await expect(guideCard).toContainText('Board, List and Flow');
  await expect(guideCard).toContainText('onInspect(item.key)');
  await expect(guideCard.getByRole('button', { name: 'Copy for agent', exact: true })).toBeVisible();
  await guideCard.scrollIntoViewIfNeeded();
  await expect(guideCard.getByRole('button', { name: 'Copy for agent', exact: true })).toBeInViewport();
  await app.window.screenshot({ path: testInfo.outputPath('agents-view-guide.png') });
  expect(errors).toEqual([]);
});
