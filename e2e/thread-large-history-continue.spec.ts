import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createSqliteDatabase } from '../packages/db/src/sqlite.js';
import { test, expect } from './fixtures/app.js';

test.use({ launchEnv: { ZCC_FAKE_PROVIDER: '1' } });

test('continuing and reading a 1200 MiB Unicode history keeps both runtime processes alive', async ({ app }) => {
  test.setTimeout(120_000);
  const { window, home } = app;
  const support = window.getByRole('dialog', { name: 'Support Zana' });
  if (await support.isVisible().catch(() => false)) await support.getByRole('button', { name: 'Dismiss' }).click();
  const id = await window.evaluate(async () => {
    const project = (await window.cc.projects.list())[0];
    const response = await fetch('/api/v1/threads', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      // Use a checkpoint provider's real server routing with the deterministic host.
      body: JSON.stringify({ projectId: project.id, providerId: 'codex', input: 'Initial turn' })
    });
    if (!response.ok) throw new Error(await response.text());
    return (await response.json()).thread.id as string;
  });
  await expect.poll(() => window.evaluate(async id => (await (await fetch(`/api/v1/threads/${id}`)).json()).thread.status, id)).toBe('idle');
  const runtimePids = () => app.electron.evaluate(({ app }) => app.getAppMetrics()
    .filter(metric => /(?:server|host)-runtime\.js/.test(metric.name ?? ''))
    .map(metric => metric.pid).sort());
  const before = await runtimePids();
  expect(before).toHaveLength(2);

  // Match the reported failure: repeated large diffs, an old resume checkpoint,
  // and a small latest page. The old continuation path materialized every byte
  // twice (checkpoint lookup + activity badges) in the server utility process.
  let diffEndSeq = 0;
  const db = createSqliteDatabase(join(home, '.zcc', 'zcc.sqlite'));
  try {
    db.pragma('busy_timeout = 5000');
    const insert = db.prepare('INSERT INTO thread_events (id, thread_id, sequence, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    let seq = (db.prepare('SELECT MAX(sequence) AS seq FROM thread_events WHERE thread_id = ?').get(id) as { seq: number }).seq;
    const add = (type: string, payload: string) => insert.run(randomUUID(), id, ++seq, type, payload, Date.now());
    db.transaction(() => {
      add('turn/completed', JSON.stringify({ type: 'turn/completed', threadId: id, scope: { kind: 'turn', turnId: 'old' }, status: 'completed', providerCheckpointId: 'old-checkpoint' }));
      // Non-Latin-1 text makes V8 retain these as two-byte strings. ASCII-only
      // fixtures understated the real heap cost by a factor of two.
      const diff = JSON.stringify({ type: 'turn/diff/updated', threadId: id, scope: { kind: 'turn', turnId: 'old' }, diff: 'x'.repeat(1024 * 1024) + '\u0100' });
      for (let i = 0; i < 1200; i++) add('turn/diff/updated', diff);
      diffEndSeq = seq;
      const tail = JSON.stringify({ type: 'provider/warning', threadId: id, scope: { kind: 'thread' }, message: 'History fixture' });
      for (let i = 0; i < 1000; i++) add('provider/warning', tail);
    })();
  } finally { db.close(); }

  // Exercise history reads alongside continuation. These used to materialize
  // the complete transcript (including every invisible workspace diff).
  const reads = await window.evaluate(async ({ id, diffEndSeq }) => {
    const results = [];
    for (const path of [
      'events/wait?type=turn%2Fcompleted&waitMs=0',
      'events/wait?type=not-present&waitMs=0',
      'timeline',
      'timeline/turn-summary-details?turnId=old&sourceSeqStart=1&sourceSeqEnd=999999',
      'conversation-outline',
      `events?limit=1000&beforeSeq=${diffEndSeq + 1}`
    ]) {
      const response = await fetch(`/api/v1/threads/${id}/${path}`);
      const body = await response.json();
      results.push({ path, status: response.status, eventCount: body?.events?.length, hasOlder: body?.hasOlder });
    }
    return results;
  }, { id, diffEndSeq });
  expect(reads.map(row => row.status)).toEqual([200, 200, 200, 200, 200, 200]);
  expect(reads.at(-1)).toMatchObject({ hasOlder: true });
  expect(reads.at(-1)!.eventCount).toBeLessThan(16);
  expect(await runtimePids()).toEqual(before);

  await window.evaluate(id => { history.pushState({}, '', `/threads/${id}`); dispatchEvent(new PopStateEvent('popstate')); }, id);
  const detail = window.getByTestId('thread-detail');
  const composer = detail.locator('.thread-command-composer');
  for (const text of ['Continue the long conversation', 'Continue once more']) {
    await expect(composer.getByTestId('thread-command-send')).toBeEnabled();
    await composer.getByTestId('thread-command-input').fill(text);
    await composer.getByTestId('thread-command-input').press('Enter');
    await expect(detail.getByTestId('thread-timeline')).toContainText(`Response to: ${text}`, { timeout: 30_000 });
    await expect.poll(() => window.evaluate(async id => (await (await fetch(`/api/v1/threads/${id}`)).json()).thread.status, id)).toBe('idle');
    expect(await runtimePids()).toEqual(before);
  }
  await expect(window.locator('.thread-status-badge.is-error')).toHaveCount(0);
});

test('history pages and expanded turn details stay accessible in the built app', async ({ app }) => {
  test.setTimeout(120_000);
  const { window, home } = app;
  const support = window.getByRole('dialog', { name: 'Support Zana' });
  if (await support.isVisible().catch(() => false)) await support.getByRole('button', { name: 'Dismiss' }).click();
  const id = await window.evaluate(async () => {
    const project = (await window.cc.projects.list())[0];
    const response = await fetch('/api/v1/threads', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, providerId: 'codex', input: 'History paging fixture' }) });
    if (!response.ok) throw new Error(await response.text());
    return (await response.json()).thread.id as string;
  });
  await expect.poll(() => window.evaluate(async id => (await (await fetch(`/api/v1/threads/${id}`)).json()).thread.status, id)).toBe('idle');
  const db = createSqliteDatabase(join(home, '.zcc', 'zcc.sqlite'));
  let detailStart = 0;
  let detailEnd = 0;
  try {
    db.pragma('busy_timeout = 5000');
    let seq = (db.prepare('SELECT MAX(sequence) AS seq FROM thread_events WHERE thread_id = ?').get(id) as { seq: number }).seq;
    const insert = db.prepare('INSERT INTO thread_events (id, thread_id, sequence, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    const add = (type: string, turnId: string, fields: object = {}) => {
      insert.run(randomUUID(), id, ++seq, type, JSON.stringify({ type, threadId: id, providerThreadId: 'fixture',
        scope: { kind: 'turn', turnId }, ...fields }), Date.now());
      return seq;
    };
    db.transaction(() => {
      for (let i = 0; i < 25; i++) {
        const turnId = `history-${i}`;
        add('client/turn/requested', turnId, { requestId: `history-request-${i}`, source: 'tell', initiator: 'user', senderThreadId: null,
          target: { kind: 'new-turn' }, input: [{ type: 'text', text: `History question ${i}`, mentions: [] }] });
        add('turn/started', turnId);
        add('item/completed', turnId, { item: { type: 'agentMessage', id: `history-answer-${i}`, text: `History answer ${i}` } });
        add('turn/completed', turnId, { status: 'completed' });
      }
      detailStart = add('turn/started', 'large-details');
      for (let i = 0; i < 1100; i++) add('item/completed', 'large-details', { item: {
        type: 'commandExecution', id: `command-${i}`, command: `echo command-${i}`, cwd: '/', status: 'completed', approvalStatus: 'not-requested',
        aggregatedOutput: `result ${i}`, exitCode: 0
      } });
      detailEnd = add('turn/completed', 'large-details', { status: 'completed' });
    })();
  } finally { db.close(); }
  await window.evaluate(id => { history.pushState({}, '', `/threads/${id}`); dispatchEvent(new PopStateEvent('popstate')); }, id);
  const timeline = window.getByTestId('thread-timeline');
  await expect(window.getByTestId('thread-load-older')).toBeVisible();
  for (let page = 0; page < 8 && !(await timeline.textContent())?.includes('History question 0'); page++) {
    const older = window.getByTestId('thread-load-older');
    if (!await older.isVisible()) break;
    await older.click();
    // The final page removes this button. Inspect existence and disabled state
    // atomically; isEnabled() can otherwise wait on a button removed after an
    // earlier isVisible() check and outlive the assertion deadline.
    await expect.poll(() => older.evaluateAll(buttons => buttons.length === 0
      || buttons.every(button => !(button as HTMLButtonElement).disabled))).toBe(true);
  }
  await expect(timeline).toContainText('History question 0');
  await expect(timeline).toContainText('History answer 24');

  const summary = timeline.getByTestId('thread-turn-summary').last();
  await summary.getByRole('button').first().click();
  await expect(summary.getByRole('button', { name: 'Load earlier details' })).toBeVisible();
  await summary.getByRole('button', { name: 'Load earlier details' }).click();
  await summary.getByRole('button', { name: /Ran.*commands/ }).click();
  await expect(summary).toContainText('command-');

  const details = await window.evaluate(async ({ id, detailStart, detailEnd }) => {
    let cursor: string | undefined;
    const ids = new Set<string>();
    let pages = 0;
    do {
      const params = new URLSearchParams({ turnId: 'large-details', sourceSeqStart: String(detailStart), sourceSeqEnd: String(detailEnd) });
      if (cursor) params.set('beforeCursor', cursor);
      const response = await fetch(`/api/v1/threads/${id}/timeline/turn-summary-details?${params}`);
      if (!response.ok) throw new Error(await response.text());
      const page = await response.json();
      for (const row of page.rows) if (row.workKind === 'command') ids.add(row.id);
      cursor = page.olderCursor ?? undefined;
      if (++pages > 10) throw new Error('History cursor failed to advance');
    } while (cursor);
    return { count: ids.size, pages };
  }, { id, detailStart, detailEnd });
  expect(details.count).toBe(1100);
  expect(details.pages).toBeGreaterThan(1);
});
