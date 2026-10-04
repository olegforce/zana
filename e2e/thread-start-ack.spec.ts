import { test, expect } from './fixtures/app.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

test.use({ launchEnv: { ZCC_FAKE_PROVIDER: '1' }, initialConfig: { sponsorPromptDismissed: true } });

test('fast first turns remain idle after the real host session acknowledgement and accept a follow-up', async ({ app, home }) => {
  test.setTimeout(120_000);
  const win = app.window;
  const root = join(home, 'fast-start-project');
  mkdirSync(root);
  const projectId = await win.evaluate(async path => {
    const response = await fetch('/api/v1/projects', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path })
    });
    if (!response.ok) throw new Error(await response.text());
    return (await response.json()).project.id as string;
  }, root);
  let lastId = '';
  for (let i = 0; i < 8; i++) {
    lastId = await win.evaluate(async ({ projectId, i }) => {
      const response = await fetch('/api/v1/threads', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId, providerId: 'fake', title: `Fast first turn ${i}`, input: 'Immediate response' })
      });
      if (!response.ok) throw new Error(await response.text());
      return (await response.json()).thread.id as string;
    }, { projectId, i });
    // Wait for both messages to be committed, whichever order the provider and
    // command acknowledgement take across the real daemon/server connection.
    await expect.poll(() => win.evaluate(async id => {
      const { events } = await (await fetch(`/api/v1/threads/${id}/events?limit=100`)).json();
      return events.some((event: { type: string }) => event.type === 'thread.started')
        && events.some((event: { type: string }) => event.type === 'turn.completed' || event.type === 'turn/completed');
    }, lastId)).toBe(true);
    expect(await win.evaluate(async id => (await (await fetch(`/api/v1/threads/${id}`)).json()).thread.status, lastId)).toBe('idle');
  }
  await win.evaluate(id => { history.pushState({}, '', `/threads/${id}`); dispatchEvent(new PopStateEvent('popstate')); }, lastId);
  const detail = win.getByTestId('thread-detail');
  await expect(detail.getByTestId('thread-timeline')).toContainText('Response to: Immediate response');
  await detail.getByTestId('thread-command-input').fill('delay:1500 Follow-up after acknowledgement');
  await detail.getByTestId('thread-command-send').click();
  await expect.poll(() => win.evaluate(async id => (await (await fetch(`/api/v1/threads/${id}`)).json()).thread.status, lastId)).toBe('active');
  await expect(detail.getByTestId('thread-timeline')).toContainText('Response to: delay:1500 Follow-up after acknowledgement');
  await expect.poll(() => win.evaluate(async id => (await (await fetch(`/api/v1/threads/${id}`)).json()).thread.status, lastId)).toBe('idle');
});
