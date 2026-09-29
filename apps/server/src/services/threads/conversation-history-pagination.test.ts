import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendConversationThreadEvent, createConversationThread, maintainConversationEventHistory, openDatabase, upsertHost, type ZccDatabase } from '@zana-ai/zcc-db';
import { mergeTimelinePages, type TimelineRow } from '@zana-ai/zcc-server-contract';
import type { ProductHttpContext } from '../../http/product-context.js';
import { conversationTimeline, conversationTimelineTurnSummaryDetails, resetTimelineLatestRowsCache } from './conversation-timeline.js';
import { decodeHistoryCursor, encodeHistoryCursor, pageTimelineRows } from './timeline-content-page.js';

let db: ZccDatabase;
let dir: string;
let threadId: string;
let ctx: ProductHttpContext;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'timeline-pages-'));
  db = openDatabase(join(dir, 'db.sqlite'));
  const host = upsertHost(db, { name: 'test', hostKeyHash: 'h'.repeat(64) });
  threadId = createConversationThread(db, { projectId: 'p', hostId: host.id, providerId: 'codex' }).id;
  ctx = { db, dataDir: dir } as ProductHttpContext;
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); resetTimelineLatestRowsCache(); });
function event(type: string, fields: Record<string, unknown> = {}, turnId = 'turn') {
  return appendConversationThreadEvent(db, { threadId, type, payload: {
    type, threadId, providerThreadId: 'provider', scope: { kind: 'turn', turnId }, ...fields
  } });
}
function messages(rows: TimelineRow[]): string[] {
  return rows.flatMap(row => row.kind === 'conversation' ? [row.text] : row.kind === 'turn' ? messages(row.children ?? [])
    : row.kind === 'work' && row.workKind === 'delegation' ? messages(row.childRows) : []);
}

it('preserves displayed answers, command results and root context capacity through pruning', () => {
  event('thread/contextWindowUsage/updated', { contextWindowUsage: { usedTokens: 1, modelContextWindow: 200000, estimated: false } });
  for (let i = 0; i < 25; i++) {
    event('client/turn/requested', { requestId: `req${i}`, input: [{ type: 'text', text: `question ${i}`, mentions: [] }],
      target: { kind: 'new-turn' }, initiator: 'user', source: 'tell', senderThreadId: null }, `turn${i}`);
    event('turn/started', {}, `turn${i}`);
    for (let n = 0; n < 4; n++) event('item/agentMessage/delta', { itemId: `answer${i}`, delta: 'part ' }, `turn${i}`);
    event('item/completed', { item: { type: 'agentMessage', id: `answer${i}`, text: `complete answer ${i}` } }, `turn${i}`);
    event('thread/contextWindowUsage/updated', { contextWindowUsage: { usedTokens: 100 + i, modelContextWindow: null, estimated: false } }, `turn${i}`);
    event('turn/completed', { status: 'completed' }, `turn${i}`);
  }
  event('turn/started');
  for (let i = 0; i < 4; i++) event('item/commandExecution/outputDelta', { itemId: 'command', delta: 'part ' });
  event('item/completed', { item: { type: 'commandExecution', id: 'command', command: 'echo result', cwd: '/',
    status: 'completed', approvalStatus: 'not-requested', aggregatedOutput: 'complete command result', exitCode: 0 } });
  event('turn/completed', { status: 'completed' });
  const before = conversationTimeline(ctx, threadId, { includeNestedRows: 'true', summaryOnly: 'false' });
  expect(before.contextWindowUsage).toMatchObject({ modelContextWindow: 200000, usedTokens: 124 });
  let removed = 0;
  for (let i = 0; i < 15; i++) for (const result of maintainConversationEventHistory(db)) removed += result.removed;
  expect(removed).toBeGreaterThan(50);
  const after = conversationTimeline(ctx, threadId, { includeNestedRows: 'true', summaryOnly: 'false' });
  expect(messages(after.rows)).toEqual(messages(before.rows));
  expect(JSON.stringify(after.rows)).toContain('complete command result');
  expect(after.contextWindowUsage).toEqual(before.contextWindowUsage);
  expect(after.maxSeq).toBe(before.maxSeq);
});

it('walks a huge turn through leaf and raw windows, retaining every message exactly once', () => {
  event('turn/started');
  for (let i = 0; i < 1400; i++) event('item/completed', { item: { type: 'agentMessage', id: `m${i}`, text: `message ${i}` } });
  event('turn/completed', { status: 'completed' });
  let page = conversationTimeline(ctx, threadId, { includeNestedRows: 'true', summaryOnly: 'false' });
  let all = page.rows;
  const seen = new Set<string>();
  while (page.timelinePage.olderCursor) {
    const cursor = page.timelinePage.olderCursor;
    expect(seen.has(cursor.anchorId)).toBe(false);
    seen.add(cursor.anchorId);
    expect(seen.size).toBeLessThan(10);
    page = conversationTimeline(ctx, threadId, { beforeAnchorId: cursor.anchorId, beforeAnchorSeq: String(cursor.anchorSeq), includeNestedRows: 'true', summaryOnly: 'false' });
    all = mergeTimelinePages(page.rows, all);
  }
  expect(messages(all)).toEqual(Array.from({ length: 1400 }, (_, i) => `message ${i}`));
});

it('pages details without loading the whole turn and hydrates only outputs that fit', () => {
  const start = event('turn/started').sequence;
  for (let i = 0; i < 1200; i++) event('item/completed', { item: {
    type: 'commandExecution', id: `cmd${i}`, command: 'echo test', cwd: '/', status: 'completed', approvalStatus: 'not-requested',
    aggregatedOutput: i === 1199 ? 'x'.repeat(5 * 1024 * 1024) : `output ${i}`, exitCode: 0
  } });
  const end = event('turn/completed', { status: 'completed' }).sequence;
  const query = { turnId: 'turn', sourceSeqStart: String(start), sourceSeqEnd: String(end) };
  let page = conversationTimelineTurnSummaryDetails(ctx, threadId, query);
  expect(JSON.stringify(page.rows).length).toBeLessThan(4 * 1024 * 1024);
  let all = page.rows;
  let pages = 1;
  while (page.olderCursor) {
    expect(pages++).toBeLessThan(10);
    page = conversationTimelineTurnSummaryDetails(ctx, threadId, { ...query, beforeCursor: page.olderCursor });
    all = mergeTimelinePages(page.rows, all);
  }
  const commands = all.filter(row => row.kind === 'work' && row.workKind === 'command');
  expect(commands).toHaveLength(1200);
  expect(new Set(commands.map(row => row.id)).size).toBe(1200);
});

it('uses conversation boundaries, excludes later appends from an older walk, and rejects changed cursor scope', () => {
  for (let i = 0; i < 25; i++) {
    event('client/turn/requested', { requestId: `req${i}`, input: [{ type: 'text', text: `question ${i}`, mentions: [] }],
      target: { kind: 'new-turn' }, initiator: 'user', source: 'tell', senderThreadId: null }, `turn${i}`);
    event('turn/started', {}, `turn${i}`);
    event('item/completed', { item: { type: 'agentMessage', id: `answer${i}`, text: `answer ${i}` } }, `turn${i}`);
    event('turn/completed', { status: 'completed' }, `turn${i}`);
  }
  const page = conversationTimeline(ctx, threadId, { includeNestedRows: 'true', summaryOnly: 'false', segmentLimit: '2' });
  expect(messages(page.rows)).toContain('answer 24');
  expect(messages(page.rows)).not.toContain('answer 22');
  const cursor = page.timelinePage.olderCursor!;
  event('item/completed', { item: { type: 'agentMessage', id: 'new', text: 'new append' } }, 'new');
  const older = conversationTimeline(ctx, threadId, { beforeAnchorId: cursor.anchorId, beforeAnchorSeq: String(cursor.anchorSeq), includeNestedRows: 'true', summaryOnly: 'false' });
  expect(older.maxSeq).toBe(page.maxSeq);
  expect(messages(older.rows)).not.toContain('new append');
  expect(() => conversationTimeline(ctx, threadId, { beforeAnchorId: cursor.anchorId, beforeAnchorSeq: String(cursor.anchorSeq) })).toThrow(/Reload/);
  db.sqlite.prepare('DELETE FROM thread_events WHERE thread_id = ? AND sequence = ?').run(threadId, cursor.anchorSeq);
  expect(() => conversationTimeline(ctx, threadId, { beforeAnchorId: cursor.anchorId, beforeAnchorSeq: String(cursor.anchorSeq), includeNestedRows: 'true', summaryOnly: 'false' })).toThrow(/Reload/);
});

it('validates cursors and makes progress for a single row larger than the response target', () => {
  expect(decodeHistoryCursor(undefined, threadId, 'test')).toBeNull();
  for (const raw of ['history1:bad', 'history1:' + 'a'.repeat(2100), encodeHistoryCursor({ threadId: 'other', surface: 'test', start: 1, end: 2, tip: 1 })]) {
    expect(() => decodeHistoryCursor(raw, threadId, 'test')).toThrow(/Reload/);
  }
  const row = { kind: 'conversation', id: 'one', text: 'x'.repeat(5000), sourceSeqStart: 1, sourceSeqEnd: 1 } as TimelineRow;
  expect(pageTimelineRows([row], undefined, 1)).toMatchObject({ rows: [row], start: 0 });
  expect(pageTimelineRows([], undefined, 1)).toMatchObject({ rows: [], start: 0 });
});

it('pages and merges nested delegation children by identity without losing parent metadata', () => {
  const leaf = (id: string, seq: number) => ({ kind: 'conversation', id, text: id, sourceSeqStart: seq, sourceSeqEnd: seq } as TimelineRow);
  const first = leaf('first', 1);
  const last = leaf('last', 2);
  const parent = { kind: 'work', workKind: 'delegation', id: 'parent', sourceSeqStart: 1, sourceSeqEnd: 2, childRows: [first, last] } as TimelineRow;
  const tail = pageTimelineRows([parent], undefined, 1);
  const head = pageTimelineRows([parent], tail.start, 1);
  expect(tail).toMatchObject({ start: 1, end: 2, total: 2 });
  expect(mergeTimelinePages(head.rows, tail.rows)).toEqual([parent]);
});

it('includes the beginning of a message whose streamed deltas cross the raw window edge', () => {
  event('turn/started');
  for (let i = 0; i < 1300; i++) event('item/agentMessage/delta', { itemId: 'stream', delta: `part${i} ` + 'x'.repeat(4000) });
  event('turn/completed', { status: 'completed' });
  const page = conversationTimeline(ctx, threadId, { includeNestedRows: 'true', summaryOnly: 'false' });
  expect(messages(page.rows).join('')).toContain('part0 ');
  expect(messages(page.rows).join('')).toContain('part1299 ');
  expect(messages(page.rows).join('').match(/part0 /g)).toHaveLength(1);
});
