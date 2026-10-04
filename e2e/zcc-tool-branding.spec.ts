import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createSqliteDatabase } from '../packages/db/src/sqlite.js';
import { test, expect } from './fixtures/app.js';

test.use({ launchEnv: { ZCC_FAKE_PROVIDER: '1' } });

test('saved host tools display ZCC while keeping their persisted execution identity', async ({ app }) => {
  const win = app.window;
  const id = await win.evaluate(async () => {
    const project = (await window.cc.projects.list())[0];
    const response = await fetch('/api/v1/threads', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, providerId: 'fake', input: 'Branding history fixture' }) });
    if (!response.ok) throw new Error(await response.text());
    return (await response.json()).thread.id as string;
  });
  await expect.poll(() => win.evaluate(async id => (await (await fetch(`/api/v1/threads/${id}`)).json()).thread.status, id)).toBe('idle');
  const db = createSqliteDatabase(join(app.home, '.zcc', 'zcc.sqlite'));
  try {
    db.pragma('busy_timeout = 5000');
    let seq = (db.prepare('SELECT MAX(sequence) AS seq FROM thread_events WHERE thread_id = ?').get(id) as { seq: number }).seq;
    const insert = db.prepare('INSERT INTO thread_events (id, thread_id, sequence, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    for (const [server, tool] of [['bb', 'inbox_push'], ['zcc', 'inbox_search'], ['external', 'lookup']]) {
      insert.run(randomUUID(), id, ++seq, 'item/completed', JSON.stringify({ type: 'item/completed', threadId: id, providerThreadId: 'fixture',
        scope: { kind: 'turn', turnId: 'branding' }, item: { type: 'toolCall', id: `${server}-call`, server, tool, arguments: {}, result: 'Saved', status: 'completed' } }), Date.now());
    }
  } finally { db.close(); }
  await win.evaluate(id => { history.pushState({}, '', `/threads/${id}`); dispatchEvent(new PopStateEvent('popstate')); }, id);
  const timeline = win.getByTestId('thread-timeline');
  await timeline.getByRole('button', { name: 'Ran 3 tools', exact: true }).click();
  for (const name of ['inbox_push', 'inbox_search', 'lookup']) await timeline.getByRole('button', { name: new RegExp(name) }).click();
  await expect(timeline).toContainText('zcc:inbox_push');
  await expect(timeline).toContainText('zcc:inbox_search');
  await expect(timeline).toContainText('external:lookup');
  await expect(timeline).not.toContainText('bb:inbox_push');
  const persisted = await win.evaluate(async id => (await (await fetch(`/api/v1/threads/${id}/events?limit=100`)).json()).events, id);
  expect(JSON.stringify(persisted)).toContain('"server":"bb"');
});
