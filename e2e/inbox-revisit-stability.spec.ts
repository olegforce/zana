// Revisiting a selected Inbox entry must paint cached content instead of loading skeletons,
// and must not re-run the AI summary on each visit.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from './fixtures/app.js';

test.use({ e2e: true, launchEnv: { ZCC_FAKE_PROVIDER: '1' }, initialConfig: { sponsorPromptDismissed: true, tmuxScope: 'off' } });

test('revisiting the Inbox shows no loading skeletons and summarises at most once', async ({ app }) => {
  test.setTimeout(120_000);
  const { window: page, electron, home } = app;
  const projectPath = join(home, 'revisit-project');
  mkdirSync(projectPath, { recursive: true });
  writeFileSync(join(projectPath, 'report.md'), '# Revisit report\n\nSynthetic document body.\n');
  const projectId = await page.evaluate(async (path) => {
    const result = await window.cc.projects.add(path);
    if (!result.ok) throw new Error(result.message);
    return result.value.id;
  }, projectPath);
  mkdirSync(join(home, '.zcc', 'inbox'), { recursive: true });
  writeFileSync(join(home, '.zcc', 'inbox', 'entries.jsonl'), `${JSON.stringify({
    id: 'revisit-report', projectId, ts: Date.now(), subject: 'Revisit stability report', comments: 'Attached document', report: true, docs: [{ path: 'report.md' }]
  })}\n`);
  await page.reload();

  await electron.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => unknown> })._invokeHandlers;
    const original = handlers.get('inbox:summarize')!;
    const g = globalThis as unknown as { __summarizeCalls: number };
    g.__summarizeCalls = 0;
    handlers.set('inbox:summarize', (...args: unknown[]) => { g.__summarizeCalls++; return original(...args); });
  });

  const row = page.locator('.inbox-row').filter({ hasText: 'Revisit stability report' });
  await page.getByTestId('nav-inbox').click();
  await row.click();
  await expect(page.locator('.inbox-detail')).toContainText('Synthetic document body');

  for (let visit = 0; visit < 3; visit++) {
    await page.getByTestId('nav-agents').click();
    await page.evaluate(() => {
      const w = window as unknown as { __loading: string[] };
      w.__loading = [];
      const scan = (text: string) => { for (const phrase of ['Loading document', 'Loading conversation']) if (text.includes(phrase)) w.__loading.push(phrase); };
      new MutationObserver((records) => {
        for (const record of records) {
          record.addedNodes.forEach(node => scan(node.textContent ?? ''));
          if (record.type === 'attributes' && record.target instanceof Element) scan(record.target.getAttribute('aria-label') ?? '');
        }
      }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-label'] });
    });
    await page.getByTestId('nav-inbox').click();
    await expect(page.locator('.inbox-detail')).toContainText('Synthetic document body');
    await page.waitForTimeout(1_000);
    expect(await page.evaluate(() => (window as unknown as { __loading: string[] }).__loading)).toEqual([]);
  }
  const calls = await electron.evaluate(() => (globalThis as unknown as { __summarizeCalls: number }).__summarizeCalls);
  expect(calls).toBeLessThanOrEqual(1);
});
