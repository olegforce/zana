import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, dismissConsentOverlays } from './fixtures/app.js';

test.use({
  e2e: true,
  launchEnv: { ZCC_FAKE_PROVIDER: '1' },
  isolateBundledCatalog: true,
  initialConfig: { agentsBoardView: 'board', sponsorPromptDismissed: true }
});

test('closing Kanban cards keeps a busy project in place', async ({ app }) => {
  const { window, home } = app;
  await dismissConsentOverlays(window);
  const names = ['Board Alpha', 'Board Beta', 'Board Gamma'];
  const paths = names.map((name) => join(home, name));
  for (const path of paths) mkdirSync(path);
  const projectIds = await window.evaluate(async ({ paths, names }) => {
    const ids: string[] = [];
    for (const [index, path] of paths.entries()) {
      const result = await window.cc.projects.add(path);
      if (!result.ok) throw new Error(result.message);
      await window.cc.projects.update(result.value.id, { name: names[index] });
      ids.push(result.value.id);
    }
    await window.cc.projects.reorder(ids);
    return ids;
  }, { paths, names });

  // Alpha has many old cards and one newest card. Closing that newest card
  // previously dropped the whole group below Beta and Gamma.
  const titles = [
    ...Array.from({ length: 8 }, (_, index) => ({ projectId: projectIds[0], title: `Alpha old ${index}` })),
    { projectId: projectIds[2], title: 'Gamma card' },
    { projectId: projectIds[1], title: 'Beta card' },
    { projectId: projectIds[0], title: 'Alpha newest' }
  ];
  for (const row of titles) {
    const threadId = await window.evaluate(async (row) => {
      const response = await fetch('/api/v1/threads', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...row, providerId: 'fake', input: 'Board ordering probe' })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(JSON.stringify(body));
      return body.thread.id as string;
    }, row);
    // Establish the idle fixture before creating its next card. Concurrent
    // provider startup is separate from the board ordering under test.
    await expect.poll(() => window.evaluate(async (id) =>
      (await (await fetch(`/api/v1/threads/${id}`)).json()).thread.status, threadId)).toBe('idle');
  }

  await window.getByTestId('nav-agents').click();
  await window.getByRole('button', { name: 'Board view', exact: true }).click();
  const idle = window.locator('[data-board-column="idle"]');
  const groups = idle.locator('.agents-lane-group-name');
  await expect(groups).toHaveText(names);
  const close = async (title: string) => {
    const card = idle.locator('.agent-card.is-thread').filter({ hasText: title });
    await card.click({ button: 'right' });
    window.once('dialog', (dialog) => void dialog.accept());
    await window.getByTestId('thread-context-menu').getByRole('button', { name: 'Archive', exact: true }).click();
    await expect(card).toHaveCount(0);
  };
  await close('Alpha newest');
  await expect(groups).toHaveText(names);
  await expect(idle.locator('.agents-lane-group').first().locator('.agents-lane-group-count')).toHaveText('8');
  await close('Alpha old 7');
  await expect(groups).toHaveText(names);
  await close('Beta card');
  await expect(groups).toHaveText(['Board Alpha', 'Board Gamma']);
  await window.getByTestId('nav-inbox').click();
  await window.getByTestId('nav-agents').click();
  await expect(groups).toHaveText(['Board Alpha', 'Board Gamma']);
});
