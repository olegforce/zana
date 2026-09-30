import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { chromium, type Locator, type Page } from '@playwright/test';
import { test, expect } from './fixtures/app.js';
import { startMobileGateway } from '../apps/server/src/mobile/gateway.js';

test.use({ initialConfig: { sponsorPromptDismissed: true }, launchEnv: { ZCC_FAKE_PROVIDER: '1' } });

// CDP touch events exercise native pointer cancellation, scrolling and synthetic
// clicks. dispatchEvent alone would miss accidental navigation after a swipe.
async function swipe(page: Page, row: Locator, dx: number, dy = 0) {
  await row.scrollIntoViewIfNeeded();
  const box = (await row.boundingBox())!;
  const start = { x: box.x + 30, y: box.y + box.height / 2 };
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
    for (let step = 1; step <= 8; step++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{
        x: start.x + dx * step / 8, y: start.y + dy * step / 8
      }] });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await cdp.detach();
  }
}

test('Mobile agent drawer excludes ended agents, stays ordered, and swipes right to close', async ({ app }, testInfo) => {
  test.setTimeout(150_000);
  const directory = join(app.home, 'mobile-swipe-project');
  mkdirSync(directory);
  writeFileSync(join(directory, 'agent.cjs'), `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('2.1.220 (Claude Code)'); process.exit(0); }
if (process.argv.includes('--ended')) process.exit(0);
process.stdout.write('MOBILE_AGENT_READY\\r\\n');
process.stdin.resume();
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  const seed = await app.window.evaluate(async (path) => {
    async function post(url: string, body: unknown) {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    }
    const { project } = await post('/api/v1/projects', { path });
    const threads: string[] = [];
    for (const title of ['First mobile agent', 'Second mobile agent', 'Archived mobile agent']) {
      const { thread } = await post('/api/v1/threads', { projectId: project.id, providerId: 'fake', title, input: `${title} delay:500` });
      threads.push(thread.id);
    }
    const { value: session } = await post('/api/v1/terminals', { projectId: project.id, profile: 'claude', title: 'Swipe CLI agent', command: './agent.cjs' });
    await post('/api/v1/terminals', { projectId: project.id, profile: 'claude', title: 'Ended CLI agent', command: './agent.cjs --ended' });
    await post(`/api/v1/threads/${threads[2]}/archive`, {});
    return { projectId: project.id as string, threads, sessionId: session.id as string };
  }, directory);
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const serverUrl = `http://127.0.0.1:${port}`;
  const gateway = await startMobileGateway({ upstream: new URL(app.window.url()).origin, publicUrl: serverUrl, port });
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const pair = await context.request.post(`${serverUrl}/_mobile/pair`, { data: { code: gateway.pair().code, label: 'Agent swipe test' } });
    const credential = await pair.json();
    expect((await context.request.post(`${serverUrl}/_mobile/session`, { headers: { authorization: `Bearer ${credential.credential}` } })).ok()).toBe(true);
    const page = await context.newPage();
    await page.goto(`${serverUrl}/threads/${seed.threads[0]}`);
    await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: 'Navigation', exact: true });
    const list = drawer.getByRole('list', { name: 'Your agents' });
    const rows = list.getByRole('link');
    await expect(rows).toHaveCount(3);
    await expect(list.getByText('Ended CLI agent')).toHaveCount(0);
    await expect(list.getByText('Archived mobile agent')).toHaveCount(0);
    for (const width of [320, 390, 820]) {
      await page.setViewportSize({ width, height: 844 });
      for (const close of await list.getByRole('button').all()) {
        const box = (await close.boundingBox())!;
        expect(box.width).toBe(1);
        expect(box.height).toBe(1);
        await expect(close).toHaveCSS('clip-path', 'inset(50%)');
      }
      const row = rows.first();
      const surface = row.locator('..');
      expect((await row.boundingBox())!.width).toBe((await surface.boundingBox())!.width);
      // An external keyboard can still reach and use a visible close control.
      await row.focus();
      await page.keyboard.press('Tab');
      const close = surface.getByRole('button');
      await expect(close).toBeFocused();
      await expect(close).toHaveCSS('clip-path', 'none');
      const box = (await close.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      await page.keyboard.press('Shift+Tab');
      await expect(close).toHaveCSS('clip-path', 'inset(50%)');
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    const first = list.locator(`a[href='/threads/${seed.threads[0]}']`);
    const second = list.locator(`a[href='/threads/${seed.threads[1]}']`);
    const cli = list.locator(`a[href='/sessions/${seed.sessionId}']`);
    const order = () => rows.evaluateAll((links) => links.map((link) => link.getAttribute('href')));
    const initialOrder = await order();
    expect(initialOrder).toEqual([`/sessions/${seed.sessionId}`, `/threads/${seed.threads[1]}`, `/threads/${seed.threads[0]}`]);
    // Real websocket activity used to move this oldest thread to the top.
    await expect.poll(async () => (await (await context.request.get(`${serverUrl}/api/v1/threads/${seed.threads[0]}`)).json()).thread.status).toBe('idle');
    expect((await context.request.post(`${serverUrl}/api/v1/threads/${seed.threads[0]}/send`, { data: { input: 'Update the oldest agent delay:3000' } })).ok()).toBe(true);
    await expect(first.locator('.mobile-agent-status')).toHaveText('Working');
    expect(await order()).toEqual(initialOrder);
    await expect(first.locator('.mobile-agent-status')).toHaveText('Idle');
    expect(await order()).toEqual(initialOrder);
    await swipe(page, first, 45);
    await expect(rows).toHaveCount(3);
    await expect(drawer).toBeVisible();
    await swipe(page, first, 0, -70);
    await expect(rows).toHaveCount(3);
    await expect(page).toHaveURL(`${serverUrl}/threads/${seed.threads[0]}`);
    await page.screenshot({ path: testInfo.outputPath('mobile-agent-drawer.png') });
    // Closing another agent leaves the selected agent and drawer intact.
    await swipe(page, second, 145);
    await expect(second).toHaveCount(0);
    await expect(drawer).toBeVisible();
    await expect(page).toHaveURL(`${serverUrl}/threads/${seed.threads[0]}`);
    const archived = await (await context.request.get(`${serverUrl}/api/v1/threads/${seed.threads[1]}`)).json();
    expect(archived.thread.archivedAt).toBeTruthy();
    await swipe(page, cli, 145);
    await expect(cli).toHaveCount(0);
    await expect(drawer).toBeVisible();
    // Keyboard close also leaves the active page and persists after reload.
    await first.focus();
    await page.keyboard.press('Tab');
    await expect(list.getByRole('button', { name: 'Close First mobile agent' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(first).toHaveCount(0);
    await expect(page).toHaveURL(`${serverUrl}/agents`);
    await page.reload();
    await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
    await expect(drawer.getByText('Your agents will appear here')).toBeVisible();
  } finally {
    await browser.close();
    await gateway.close();
  }
});
