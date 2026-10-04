import { chromium, expect } from '@playwright/test';

// Run against a production website build with NEXT_PUBLIC_GA_MEASUREMENT_ID set.
// Google's script is intercepted: this verification sends no real analytics.
const baseUrl = process.env.ANALYTICS_TEST_BASE_URL ?? 'http://127.0.0.1:4321';
await expect.poll(async () => {
  try { return (await fetch(`${baseUrl}/`)).status; } catch { return 0; }
}, { timeout: 30_000 }).toBe(200);
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  let tagLoads = 0;
  await context.route('https://www.googletagmanager.com/**', async route => {
    tagLoads++;
    await route.fulfill({ contentType: 'text/javascript', body: '' });
  });
  await context.route(/https:\/\/[^/]*google-analytics\.com\//, route => route.abort());
  const page = await context.newPage();
  const events = () => page.evaluate(() => (window.dataLayer ?? []).map(args => Array.from(args)).filter(args => args[0] === 'event'));
  await page.goto(`${baseUrl}/?code=private#private`);
  await expect(page.getByRole('button', { name: 'Accept analytics' })).toBeVisible();
  expect(tagLoads).toBe(0);
  expect(await events()).toHaveLength(0);
  await page.getByRole('button', { name: 'Accept analytics' }).click();
  await expect.poll(() => tagLoads).toBe(1);
  await expect.poll(async () => (await events()).length).toBe(1);
  expect((await events())[0][2].page_location).toBe(`${baseUrl}/`);

  await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Download', exact: true }).click();
  await expect.poll(async () => (await events()).length).toBe(2);
  await page.locator('a[data-analytics="download"]').evaluate(link => link.addEventListener('click', event => event.preventDefault()));
  await page.getByRole('link', { name: 'Download for macOS' }).click();
  await expect.poll(async () => (await events()).at(-1)[1]).toBe('download_click');

  await page.getByRole('button', { name: 'Analytics cookies', exact: true }).click();
  await page.getByRole('button', { name: 'Decline', exact: true }).click();
  expect(await page.evaluate(() => localStorage.getItem('zana-site-analytics'))).toBe('denied');
  const eventCount = (await events()).length;
  await page.getByRole('link', { name: 'Zana home', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Analytics cookies', exact: true })).toBeVisible();
  expect((await events()).length).toBe(eventCount);
  expect(tagLoads).toBe(1);

  const privateContext = await browser.newContext();
  await privateContext.addInitScript(() => localStorage.setItem('zana-site-analytics', 'granted'));
  await privateContext.route('https://www.googletagmanager.com/**', () => { throw new Error('Google loaded on private account page'); });
  const privatePage = await privateContext.newPage();
  await privatePage.goto(`${baseUrl}/connect/?phone=private`);
  await expect(privatePage.locator('main')).toBeVisible();
  expect(await privatePage.evaluate(() => window.dataLayer)).toBeUndefined();
  expect(await privatePage.getByRole('button', { name: 'Analytics cookies', exact: true }).count()).toBe(0);
  console.log('Production analytics verification passed: consent, route views, download clicks, sanitized URLs, decline and private-page exclusion.');
} finally {
  await browser.close();
}
