import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendConversationThreadEvent, copyConversationThreadEvents, createConversationThread, deleteConversationThreadEventsAfter,
  hydrateConversationOutputs, listConversationThreadEvents, maintainConversationHistory, nextConversationEventSequence,
  openDatabase, upsertHost, type ZccDatabase } from '../index.js';
import { CONVERSATION_OUTPUT_RETENTION_MS, prepareConversationOutput } from './conversation-output.js';

let db: ZccDatabase;
let dir: string;
let threadId: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'history-output-'));
  db = openDatabase(join(dir, 'db.sqlite'));
  const host = upsertHost(db, { name: 'test', hostKeyHash: 'h'.repeat(64) });
  threadId = createConversationThread(db, { projectId: 'p', hostId: host.id, providerId: 'codex' }).id;
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
const output = 'head😀' + 'Ā'.repeat(40_000) + 'tail😀';
const payload = (text = output) => ({ type: 'item/completed', item: { type: 'commandExecution', aggregatedOutput: text } });
const add = (type: string, value: unknown) => appendConversationThreadEvent(db, { threadId, type, payload: value });

it.each([false, true])('stores previews atomically and restores full outputs within a byte budget (wrapped=%s)', wrapped => {
  const original = wrapped ? { event: payload() } : payload();
  const row = add('item/completed', original);
  expect(JSON.stringify(row.payload).length).toBeLessThan(5000);
  expect(JSON.stringify(original)).toContain(output);
  expect(hydrateConversationOutputs(db, [row], 1000)).toEqual([row]);
  expect(hydrateConversationOutputs(db, [row], 200_000)[0]?.payload).toMatchObject(original);
  expect(hydrateConversationOutputs(db, [row], 200_000, Date.now() + CONVERSATION_OUTPUT_RETENTION_MS + 1)).toEqual([row]);
  expect(listConversationThreadEvents(db, threadId)).toEqual([row]);
  db.sqlite.exec(`CREATE TRIGGER reject_output BEFORE INSERT ON conversation_event_outputs BEGIN SELECT RAISE(ABORT, 'test failure'); END`);
  expect(() => add('item/completed', payload())).toThrow('test failure');
  expect(listConversationThreadEvents(db, threadId)).toHaveLength(1);
});

it('leaves messages, non-string results, small outputs and incomplete events untouched', () => {
  for (const value of [null, [], { item: null }, { item: { type: 'toolCall', result: {} } }, payload('small'),
    { item: { type: 'agentMessage', text: output } }]) {
    expect(prepareConversationOutput('item/completed', value, 0)).toEqual({ payload: value });
  }
  const value = payload();
  expect(prepareConversationOutput('item/started', value, 0)).toEqual({ payload: value });
});

it('never hydrates an oversized output across SQLite/V8, including JSON escaping costs', () => {
  const row = add('item/completed', payload('\u0000'.repeat(40_000)));
  expect(hydrateConversationOutputs(db, [row], 100_000)).toEqual([row]);
  expect(JSON.stringify(hydrateConversationOutputs(db, [row], 300_000))).toContain('\\u0000');
});

it('copies retained output with its original expiry and cascades deletion on rewind', () => {
  const row = add('item/completed', payload());
  const hostId = (db.sqlite.prepare('SELECT host_id FROM threads WHERE id = ?').get(threadId) as { host_id: string }).host_id;
  const target = createConversationThread(db, { projectId: 'p', hostId, providerId: 'codex' });
  const copied = copyConversationThreadEvents(db, { targetThreadId: target.id, rows: [row] });
  expect(hydrateConversationOutputs(db, copied, 200_000)[0]?.payload).toMatchObject(payload());
  deleteConversationThreadEventsAfter(db, threadId, 0);
  expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM conversation_event_outputs').get()).toEqual({ count: 1 });
  expect(hydrateConversationOutputs(db, copied, 200_000)[0]?.payload).toMatchObject(payload());
});

it('prunes in small batches, keeps messages and the sequence high-water mark, and resumes after reopen', () => {
  const message = add('item/completed', { item: { type: 'agentMessage', text: 'keep' } });
  for (let i = 0; i < 40; i++) add('turn/diff/updated', { diff: 'old snapshot' });
  const next = nextConversationEventSequence(db, threadId);
  expect(maintainConversationHistory(db)).toEqual({ snapshots: 32, outputs: 0 });
  db.close(); db = openDatabase(join(dir, 'db.sqlite'));
  expect(maintainConversationHistory(db)).toEqual({ snapshots: 7, outputs: 0 });
  expect(nextConversationEventSequence(db, threadId)).toBe(next);
  expect(listConversationThreadEvents(db, threadId)[0]).toEqual(message);
  const retained = add('item/completed', payload());
  expect(maintainConversationHistory(db, Date.now() + CONVERSATION_OUTPUT_RETENTION_MS + 1)).toEqual({ snapshots: 0, outputs: 1 });
  expect(maintainConversationHistory(db)).toEqual({ snapshots: 1, outputs: 0 });
  expect(listConversationThreadEvents(db, threadId)).toEqual([message, retained]);
});

it('bounds legacy inline tool outputs inside SQL without changing the stored event', () => {
  const row = add('item/started', { event: payload('x'.repeat(17 * 1024 * 1024)) });
  const preview = listConversationThreadEvents(db, threadId, { inlineOutputChars: 4000 });
  expect(JSON.stringify(preview).length).toBeLessThan(5000);
  expect(() => listConversationThreadEvents(db, threadId)).toThrow(/too large/);
  expect(db.sqlite.prepare('SELECT length(payload) AS length FROM thread_events WHERE id = ?').get(row.id))
    .toEqual({ length: JSON.stringify(row.payload).length });
});
