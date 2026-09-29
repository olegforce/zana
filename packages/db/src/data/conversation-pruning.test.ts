import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendConversationThreadEvent, conversationTimelineHeadEvents, createConversationThread, maintainConversationEventHistory,
  nextConversationEventSequence, openDatabase, upsertHost, type ConversationPruningPolicy, type ZccDatabase
} from '../index.js';

let db: ZccDatabase, dir: string, threadId: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'conversation-pruning-'));
  db = openDatabase(join(dir, 'db.sqlite'));
  const host = upsertHost(db, { name: 'test', hostKeyHash: 'h'.repeat(64) });
  threadId = createConversationThread(db, { projectId: 'p', hostId: host.id, providerId: 'codex' }).id;
});
afterEach(() => { vi.restoreAllMocks(); db.close(); rmSync(dir, { recursive: true, force: true }); });
function add(type: string, fields: Record<string, unknown> = {}, wrapped = false, target = threadId) {
  const payload = { type, threadId: target, scope: { kind: 'turn', turnId: 'turn' }, ...fields };
  return appendConversationThreadEvent(db, { threadId: target, type, payload: wrapped ? { event: payload } : payload });
}
const ids = () => (db.sqlite.prepare('SELECT id FROM thread_events WHERE thread_id = ? ORDER BY sequence').all(threadId) as { id: string }[]).map(row => row.id);
const batch = (policy: ConversationPruningPolicy) => maintainConversationEventHistory(db, policy)[0]!;
function sweep(policy: ConversationPruningPolicy) {
  let removed = 0;
  for (let i = 0; i < 200; i++) {
    const result = batch(policy);
    expect(result.scanned).toBeLessThanOrEqual(32);
    expect(result.removed).toBeLessThanOrEqual(32);
    removed += result.removed;
    if (result.threadId === null) return removed;
  }
  throw new Error('Pruning cursor did not finish a cycle');
}

it('bounds rate-limit batches, rechecks archive status, and preserves the sequence anchor', () => {
  const rows = Array.from({ length: 45 }, () => add('provider/rateLimits/updated'));
  expect(batch('rate-limits').removed).toBe(32);
  db.close(); db = openDatabase(join(dir, 'db.sqlite'));
  expect(sweep('rate-limits')).toBe(12);
  expect(ids()).toEqual([rows.at(-1)!.id]);
  db.sqlite.prepare('UPDATE threads SET archived_at = 1 WHERE id = ?').run(threadId);
  expect(sweep('rate-limits')).toBe(0);
  const next = nextConversationEventSequence(db, threadId);
  const message = add('item/completed', { item: { type: 'agentMessage', id: 'answer', text: 'keep' } });
  expect(sweep('rate-limits')).toBe(1);
  expect(message.sequence).toBe(next);
  expect(ids()).toEqual([message.id]);
});

it.each([false, true])('keeps root usage and the last known capacity, including wrapped events (%s)', wrapped => {
  const capacity = add('thread/contextWindowUsage/updated', { contextWindowUsage: { usedTokens: 100, modelContextWindow: 200000, estimated: false } }, wrapped);
  add('thread/contextWindowUsage/updated', { contextWindowUsage: { usedTokens: 200, modelContextWindow: null, estimated: false } }, wrapped);
  const root = add('thread/contextWindowUsage/updated', { contextWindowUsage: { usedTokens: 300, modelContextWindow: null, estimated: false } }, wrapped);
  add('thread/tokenUsage/updated');
  const token = add('thread/tokenUsage/updated', {}, wrapped);
  const nested = add('turn/started', { scope: { kind: 'turn', turnId: 'nested' }, parentToolCallId: 'parent' }, wrapped);
  add('thread/contextWindowUsage/updated', { scope: { kind: 'turn', turnId: 'nested' }, contextWindowUsage: { usedTokens: 500, modelContextWindow: 999 } }, wrapped);
  add('thread/tokenUsage/updated', { scope: { kind: 'turn', turnId: 'nested' } }, wrapped);
  const end = add('turn/completed');
  expect(sweep('context-usage')).toBe(2);
  expect(sweep('token-usage')).toBe(2);
  expect(ids()).toEqual([capacity.id, root.id, token.id, nested.id, end.id]);
});

it('resumes two-pass discovery across reopen and restarts if a keeper was rewound', () => {
  const rows = Array.from({ length: 70 }, (_, i) => add('thread/contextWindowUsage/updated', {
    contextWindowUsage: { usedTokens: i, modelContextWindow: i === 2 ? 200000 : null }
  }));
  const end = add('turn/completed');
  expect(batch('context-usage').removed).toBe(0);
  db.close(); db = openDatabase(join(dir, 'db.sqlite'));
  expect(batch('context-usage').removed).toBe(0);
  expect(batch('context-usage').removed).toBe(0);
  db.sqlite.prepare('DELETE FROM thread_events WHERE id = ?').run(rows.at(-1)!.id);
  expect(batch('context-usage')).toMatchObject({ scanned: 0, removed: 0 });
  sweep('context-usage');
  expect(ids()).toEqual([rows[2]!.id, rows.at(-2)!.id, end.id]);
});

it.each([
  ['item/agentMessage/delta', { type: 'agentMessage', text: 'full answer' }],
  ['item/commandExecution/outputDelta', { type: 'commandExecution', aggregatedOutput: '' }],
  ['item/reasoning/summaryTextDelta', { type: 'reasoning', summary: ['summary'], content: [] }],
  ['item/reasoning/textDelta', { type: 'reasoning', summary: [], content: ['full reasoning'] }]
])('prunes resolved %s fragments but retains the first fragment and final item', (type, item) => {
  const rows = Array.from({ length: 70 }, (_, i) => add(type as string, { itemId: 'item', delta: 'fragment' }, i % 2 === 0));
  const completed = add('item/completed', { item: { ...item as object, id: 'item' } }, true);
  const next = nextConversationEventSequence(db, threadId);
  expect(batch('deltas').removed).toBe(31);
  db.close(); db = openDatabase(join(dir, 'db.sqlite'));
  expect(sweep('deltas')).toBe(38);
  expect(ids()).toEqual([rows[0]!.id, completed.id]);
  expect(nextConversationEventSequence(db, threadId)).toBe(next);
});

it('does not prune open fragments, missing/empty final content, or different turn/parent/kind identities', () => {
  const type = 'item/commandExecution/outputDelta';
  for (const id of ['open', 'missing', 'null', 'wrong-kind', 'nested', 'other-turn', 'after-final']) {
    add(type, { itemId: id, delta: 'one' }); add(type, { itemId: id, delta: 'two' });
  }
  add('item/completed', { item: { type: 'commandExecution', id: 'missing' } });
  add('item/completed', { item: { type: 'commandExecution', id: 'null', aggregatedOutput: null } });
  add('item/completed', { item: { type: 'agentMessage', id: 'wrong-kind', text: 'answer' } });
  add('item/completed', { item: { type: 'commandExecution', id: 'nested', parentToolCallId: 'parent', aggregatedOutput: 'out' } });
  add('item/completed', { scope: { kind: 'turn', turnId: 'another' }, item: { type: 'commandExecution', id: 'other-turn', aggregatedOutput: 'out' } });
  add('item/agentMessage/delta', { itemId: 'empty', delta: 'one' }); add('item/agentMessage/delta', { itemId: 'empty', delta: 'two' });
  add('item/completed', { item: { type: 'agentMessage', id: 'empty', text: '' } });
  add('item/reasoning/textDelta', { itemId: 'malformed', delta: 'one' }); add('item/reasoning/textDelta', { itemId: 'malformed', delta: 'two' });
  add('item/completed', { item: { type: 'reasoning', id: 'malformed', summary: 'not an array', content: 'not json' } });
  add('item/reasoning/textDelta', { itemId: 'empty-reasoning', delta: 'one' }); add('item/reasoning/textDelta', { itemId: 'empty-reasoning', delta: 'two' });
  add('item/completed', { item: { type: 'reasoning', id: 'empty-reasoning', summary: [''], content: [] } });
  add(type, { itemId: 'no-turn', scope: { kind: 'thread' }, delta: 'one' }); add(type, { itemId: 'no-turn', scope: { kind: 'thread' }, delta: 'two' });
  add('item/completed', { scope: { kind: 'thread' }, item: { type: 'commandExecution', id: 'no-turn', aggregatedOutput: 'out' } });
  add(type, { delta: 'without item identity' });
  const before = ids();
  expect(sweep('deltas')).toBe(0);
  expect(ids()).toEqual(before);
  const final = add('item/completed', { item: { type: 'commandExecution', id: 'after-final', aggregatedOutput: 'out' } });
  const late = add(type, { itemId: 'after-final', delta: 'late update' });
  expect(sweep('deltas')).toBe(1);
  expect(ids()).toEqual(expect.arrayContaining([final.id, late.id]));
});

it('keeps active task state, removes superseded progress, and retains starts and final results', () => {
  const task = { type: 'backgroundTask', id: 'task', status: 'pending' };
  const start = add('item/started', { item: task });
  add('item/backgroundTask/progress', { item: task, scope: { kind: 'thread' } });
  const latest = add('item/backgroundTask/progress', { item: task, scope: { kind: 'thread' } }, true);
  const nested = add('item/backgroundTask/progress', { item: { ...task, parentToolCallId: 'nested' }, scope: { kind: 'thread' } });
  const wrong = add('item/backgroundTask/progress', { item: { ...task, type: 'agentMessage' }, scope: { kind: 'thread' } });
  const end = add('turn/completed');
  expect(sweep('background')).toBe(1);
  expect(ids()).toEqual([start.id, latest.id, nested.id, wrong.id, end.id]);
  const completed = add('item/backgroundTask/completed', { item: { ...task, status: 'completed' }, scope: { kind: 'thread' } });
  expect(sweep('background')).toBe(1);
  expect(ids()).toEqual([start.id, nested.id, wrong.id, end.id, completed.id]);
});

it('revisits old candidates after a late completion, without touching another thread', () => {
  const first = add('item/agentMessage/delta', { itemId: 'same', delta: 'first' });
  add('item/agentMessage/delta', { itemId: 'same', delta: 'second' });
  const hostId = (db.sqlite.prepare('SELECT host_id FROM threads WHERE id = ?').get(threadId) as { host_id: string }).host_id;
  const other = createConversationThread(db, { projectId: 'p', hostId, providerId: 'codex' }).id;
  const otherFinal = add('item/completed', { item: { type: 'agentMessage', id: 'same', text: 'other answer' } }, false, other);
  expect(sweep('deltas')).toBe(0);
  const completed = add('item/completed', { item: { type: 'agentMessage', id: 'same', text: 'our answer' } });
  expect(sweep('deltas')).toBe(1);
  expect(ids()).toEqual([first.id, completed.id]);
  expect(db.sqlite.prepare('SELECT id FROM thread_events WHERE thread_id = ?').all(other)).toEqual([{ id: otherFinal.id }]);
});

it('rolls back cursor and deletes on failure, restores busy timeout, and advances after thread deletion', () => {
  const first = add('provider/rateLimits/updated'); add('provider/rateLimits/updated');
  db.sqlite.exec(`CREATE TRIGGER reject_prune BEFORE DELETE ON thread_events BEGIN SELECT RAISE(ABORT, 'test failure'); END`);
  expect(() => batch('rate-limits')).toThrow('test failure');
  expect(db.sqlite.pragma('busy_timeout', { simple: true })).toBe(5000);
  expect(ids()).toContain(first.id);
  expect(db.sqlite.prepare('SELECT * FROM conversation_event_pruning_cursors').all()).toEqual([]);
  db.sqlite.exec('DROP TRIGGER reject_prune');
  expect(batch('rate-limits').removed).toBe(1);
  db.sqlite.prepare('DELETE FROM threads WHERE id = ?').run(threadId);
  expect(sweep('rate-limits')).toBe(0);
  expect(maintainConversationEventHistory(db)).toHaveLength(5);
});

it('uses indexed support probes and never selects payloads into JavaScript', () => {
  add('item/agentMessage/delta', { itemId: 'item', delta: 'one' });
  const candidate = add('item/agentMessage/delta', { itemId: 'item', delta: 'two' });
  add('item/completed', { item: { type: 'agentMessage', id: 'item', text: 'complete' } });
  const prepare = vi.spyOn(db.sqlite, 'prepare');
  expect(batch('deltas').removed).toBe(1);
  const statement = prepare.mock.calls.map(([sql]) => sql).find(sql => sql.startsWith('DELETE FROM thread_events AS candidate'))!;
  const plan = JSON.stringify(db.sqlite.prepare('EXPLAIN QUERY PLAN ' + statement).all(candidate.id));
  expect(plan).toContain('thread_events_delta_identity_idx');
  expect(plan).toContain('thread_events_completed_identity_idx');
  expect(plan).not.toMatch(/SCAN (?:earlier|final|candidate)/);
  expect(prepare.mock.calls.every(([sql]) => !/SELECT\s+(?:candidate\.)?payload\b/i.test(sql))).toBe(true);
});

it('retains old capacity in the bounded header even after hundreds of updates without capacity', () => {
  const capacity = add('thread/contextWindowUsage/updated', { contextWindowUsage: { modelContextWindow: 200000, usedTokens: 1 } }, true);
  let root = capacity;
  for (let i = 0; i < 100; i++) root = add('thread/contextWindowUsage/updated', { contextWindowUsage: { modelContextWindow: null, usedTokens: i } });
  add('turn/started', { scope: { kind: 'turn', turnId: 'child' }, parentToolCallId: 'parent' });
  add('thread/contextWindowUsage/updated', { scope: { kind: 'turn', turnId: 'child' }, contextWindowUsage: { modelContextWindow: 900, usedTokens: 1 } });
  expect(conversationTimelineHeadEvents(db, threadId).map(row => row.id)).toEqual([capacity.id, root.id]);
  sweep('context-usage');
  expect(conversationTimelineHeadEvents(db, threadId).map(row => row.id)).toEqual([capacity.id, root.id]);
});

it('defers immediately on a competing writer and restores the normal timeout', () => {
  add('provider/rateLimits/updated'); add('provider/rateLimits/updated');
  const writer = openDatabase(join(dir, 'db.sqlite'));
  try {
    writer.sqlite.exec('BEGIN IMMEDIATE');
    expect(() => batch('rate-limits')).toThrow(/locked/);
    expect(db.sqlite.pragma('busy_timeout', { simple: true })).toBe(5000);
  } finally { writer.sqlite.exec('ROLLBACK'); writer.close(); }
  expect(batch('rate-limits').removed).toBe(1);
});

it('migrates legacy malformed completed items safely and does not treat them as completion witnesses', () => {
  const indexes = db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name IN ('thread_events_type_thread_seq_idx', 'thread_events_delta_candidates_idx', 'thread_events_delta_identity_idx', 'thread_events_completed_identity_idx', 'thread_events_background_identity_idx', 'thread_events_nested_turn_idx', 'thread_events_context_capacity_idx')").all() as { name: string }[];
  for (const { name } of indexes) db.sqlite.exec(`DROP INDEX ${name}`);
  db.sqlite.exec('DROP TABLE conversation_event_pruning_cursors; DELETE FROM runtime_schema_migrations WHERE version=24');
  add('item/agentMessage/delta', { itemId: 'legacy', delta: 'one' });
  add('item/agentMessage/delta', { itemId: 'legacy', delta: 'two' });
  db.sqlite.prepare("INSERT INTO thread_events (id,thread_id,sequence,type,payload,created_at) VALUES ('bad',?,3,'item/completed','not json',0)").run(threadId);
  db.close(); db = openDatabase(join(dir, 'db.sqlite'));
  expect(sweep('deltas')).toBe(0);
  expect(ids()).toHaveLength(3);
  expect(db.sqlite.prepare('SELECT version FROM runtime_schema_migrations WHERE version=24').get()).toEqual({ version: 24 });
});
