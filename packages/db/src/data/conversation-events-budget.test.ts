import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendConversationThreadEvent, createConversationThread, openDatabase, upsertHost,
  CONVERSATION_EVENT_READ_MAX_BYTES, ConversationHistoryReadLimitError,
  getConversationThreadEventAfter, listConversationThreadEvents,
  listConversationThreadEventsWindow, type ZccDatabase
} from '../index.js';

let db: ZccDatabase;
let dir: string;
let threadId: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'event-read-budget-'));
  db = openDatabase(join(dir, 'db.sqlite'));
  const host = upsertHost(db, { name: 'test', hostKeyHash: 'h'.repeat(64) });
  threadId = createConversationThread(db, { projectId: 'p', hostId: host.id, providerId: 'codex' }).id;
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
const add = (type: string, payload: unknown = {}) => appendConversationThreadEvent(db, { threadId, type, payload });

it('pages on bytes as well as row count, without losing or duplicating events', () => {
  const payload = { text: 'x'.repeat(CONVERSATION_EVENT_READ_MAX_BYTES / 3) };
  const ids = Array.from({ length: 5 }, () => add('item/completed', payload).id);
  const last = listConversationThreadEventsWindow(db, threadId, { limit: 100 });
  expect(last.map(row => row.id)).toEqual(ids.slice(3));
  const previous = listConversationThreadEventsWindow(db, threadId, { limit: 100, beforeSeq: last[0]!.sequence });
  const first = listConversationThreadEventsWindow(db, threadId, { limit: 100, beforeSeq: previous[0]!.sequence });
  expect([...first, ...previous, ...last].map(row => row.id)).toEqual(ids);
  expect(() => listConversationThreadEvents(db, threadId)).toThrow(ConversationHistoryReadLimitError);
});

it('omits ignored payloads inside SQLite while preserving all event positions', () => {
  // This exceeds the single-event budget, so succeeding also proves exclusion
  // happens before the native string allocation and JSON parsing.
  const diff = add('turn/diff/updated', { diff: 'x'.repeat(CONVERSATION_EVENT_READ_MAX_BYTES + 1) });
  const done = add('turn/completed', { providerCheckpointId: 'keep' });
  const opts = { omitPayloadTypes: ['turn/diff/updated', 'unused'] };
  expect(listConversationThreadEvents(db, threadId, opts)).toEqual([{ ...diff, payload: {} }, done]);
  expect(listConversationThreadEventsWindow(db, threadId, { ...opts, limit: 10 })).toEqual([{ ...diff, payload: {} }, done]);
  expect(listConversationThreadEventsWindow(db, threadId, { limit: 10 })).toEqual([done]);
  expect(() => listConversationThreadEventsWindow(db, threadId, { limit: 10, beforeSeq: done.sequence })).toThrow(ConversationHistoryReadLimitError);
  expect(listConversationThreadEvents(db, threadId, { afterSeq: diff.sequence, beforeSeq: done.sequence + 1 })).toEqual([done]);
});

it('filters event polling before reading and returns the first match strictly after the cursor', () => {
  add('turn/diff/updated', { diff: 'x'.repeat(CONVERSATION_EVENT_READ_MAX_BYTES + 1) });
  const first = add('turn/completed', { providerCheckpointId: 'first' });
  const second = add('turn/completed', { providerCheckpointId: 'second' });
  expect(getConversationThreadEventAfter(db, threadId, 'turn/completed', 0)).toEqual(first);
  expect(getConversationThreadEventAfter(db, threadId, 'turn/completed', first.sequence)).toEqual(second);
  expect(getConversationThreadEventAfter(db, threadId, 'turn/completed', second.sequence)).toBeNull();
  expect(getConversationThreadEventAfter(db, 'other', 'turn/completed', 0)).toBeNull();
  expect(() => getConversationThreadEventAfter(db, threadId, 'turn/diff/updated', 0)).toThrow(ConversationHistoryReadLimitError);
});

it('bounds full-history metadata count and allows a small window of the same history', () => {
  db.sqlite.prepare(`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 50001)
    INSERT INTO thread_events (id,thread_id,sequence,type,payload,created_at)
    SELECT 'budget-' || n, ?, n, 'test', '{}', 0 FROM numbers`).run(threadId);
  expect(() => listConversationThreadEvents(db, threadId)).toThrow(ConversationHistoryReadLimitError);
  expect(listConversationThreadEventsWindow(db, threadId, { limit: 1 })[0]?.sequence).toBe(50001);
});

it('retains conversation messages and wrapped messages without materializing tool outputs for outlines', () => {
  const tool = add('item/completed', { item: { type: 'commandExecution', output: 'x'.repeat(CONVERSATION_EVENT_READ_MAX_BYTES + 1) } });
  const message = add('item/completed', { item: { type: 'agentMessage', text: 'Answer' } });
  const wrapped = add('item/started', { event: { item: { type: 'userMessage', text: 'Question' } } });
  expect(listConversationThreadEvents(db, threadId, { onlyItemTypes: ['agentMessage', 'userMessage'] }))
    .toEqual([{ ...tool, payload: {} }, message, wrapped]);
  expect(listConversationThreadEvents(db, threadId, { onlyItemTypes: [] }).map(row => row.payload)).toEqual([{}, {}, {}]);
});
