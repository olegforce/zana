import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from './fixtures/app.js';
import type { TimelineRow } from '@zana-ai/zcc-server-contract';

test.use({ launchEnv: { ZCC_FAKE_PROVIDER: '1' }, isolateBundledCatalog: true, initialConfig: { sponsorPromptDismissed: true, tmuxScope: 'off' } });

async function createThread(app: { window: import('@playwright/test').Page; home: string }) {
  const path = join(app.home, 'renderer-budget-project'); mkdirSync(path);
  const id = await app.window.evaluate(async path => {
    const project = await window.cc.projects.add(path);
    if (!project.ok) throw new Error(project.message);
    const response = await fetch('/api/v1/threads', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: project.value.id, providerId: 'fake', input: 'Renderer budget ready' }) });
    if (!response.ok) throw new Error(await response.text());
    return (await response.json()).thread.id as string;
  }, realpathSync(path));
  await expect.poll(() => app.window.evaluate(async id => (await (await fetch(`/api/v1/threads/${id}`)).json()).thread.status, id)).toBe('idle');
  return { id, path:realpathSync(path) };
}

test('loaded timeline DOM stays bounded while paging and searching older messages', async ({ app }) => {
  const { id } = await createThread(app);
  const rows: TimelineRow[] = Array.from({ length: 1000 }, (_, index) => ({
    id: `budget-${index}`, threadId: id, turnId: 'budget-turn', sourceSeqStart: index+1, sourceSeqEnd: index+1,
    startedAt: index+1, createdAt: index+1, kind:'system', systemKind:'error', title:`Budget message ${index}`, detail:null, status:'error'
  }));
  await app.window.route(url => url.pathname === `/api/v1/threads/${id}/timeline`, route => route.fulfill({ json: {
    rows, maxSeq:1000, status:'idle', activeThinking:null
  } }));
  await app.window.evaluate(id => { history.pushState({},'',`/threads/${id}`); dispatchEvent(new PopStateEvent('popstate')); }, id);
  const timeline = app.window.getByTestId('thread-timeline');
  await expect(timeline.locator('[data-row-id]')).toHaveCount(200);
  await expect(timeline).toContainText('Budget message 999');
  for (let page=0;page<4;page++) await timeline.getByTestId('timeline-earlier-page').click();
  await expect(timeline).toContainText('Budget message 0');
  await expect(timeline.locator('[data-row-id]')).toHaveCount(200);
  await app.window.getByRole('button',{ name:'Search in thread',exact:true }).click();
  const search = app.window.getByRole('searchbox',{ name:'Search in thread' });
  await search.fill('Budget message 700'); await search.press('Enter');
  await expect(timeline.locator('[data-row-id="budget-700"]')).toBeVisible();
  await expect(timeline.locator('[data-row-id]')).toHaveCount(200);
  await search.press('Escape');
  await timeline.evaluate(node => { node.scrollTop=0; node.dispatchEvent(new Event('scroll',{ bubbles:true })); });
  await app.window.getByRole('button',{ name:'Scroll to bottom' }).click();
  await expect(timeline).toContainText('Budget message 999');
  await expect(timeline.locator('[data-row-id]')).toHaveCount(200);
});

test.describe('installed code editor', () => {
test.use({ isolateBundledCatalog:false });
test('cold shell defers Monaco until the installed file editor opens and supplies its worker', async ({ app }) => {
  expect(await app.window.evaluate(() => Boolean((globalThis as any).__ZCC_MONACO__))).toBe(false);
  const { id, path } = await createThread(app);
  const file = join(path,'budget-editor.ts'); writeFileSync(file,'export const budgetValue = 123;\n');
  const installed = await app.window.evaluate(() => window.cc.extensions.install({ kind:'bundled', id:'monaco-editor' }));
  expect(installed,JSON.stringify(installed)).toMatchObject({ ok:true });
  expect(await app.window.evaluate(() => Boolean((globalThis as any).__ZCC_MONACO__))).toBe(false);
  await app.window.evaluate(({ id,file }) => {
    localStorage.setItem(`zcc.secondaryPanel.${id}`,JSON.stringify({ version:1,isOpen:true,isMaximized:false,widthPx:450,activeId:'code',
      tabs:[{ id:'code',kind:'file-preview',title:'budget-editor.ts',path:file }] }));
    history.pushState({},'',`/threads/${id}`); dispatchEvent(new PopStateEvent('popstate'));
  },{ id,file });
  const opener = app.window.getByTestId('thread-file-open-with');
  await expect(opener).toBeVisible();
  const value = await opener.locator('option').filter({ hasText:/^File Editor$/ }).getAttribute('value');
  expect(value).toBeTruthy(); await opener.selectOption(value!);
  await expect(app.window.locator('.monaco-editor')).toContainText('budgetValue');
  expect(await app.window.evaluate(async () => {
    const monaco = (globalThis as any).__ZCC_MONACO__;
    const getWorker = await monaco.typescript.getTypeScriptWorker();
    const worker = await getWorker(monaco.editor.getModels()[0].uri);
    return Array.isArray(await worker.getSyntacticDiagnostics(monaco.editor.getModels()[0].uri.toString()));
  })).toBe(true);
});
});
