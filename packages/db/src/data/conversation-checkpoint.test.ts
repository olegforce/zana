import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, upsertHost, createConversationThread, appendConversationThreadEvent,
  getLatestConversationCheckpoint, deleteConversationThreadEventsAfter, type ZccDatabase } from '../index.js';

let db: ZccDatabase;
let dir: string;
afterEach(() => { db?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

it('reads the newest nonempty checkpoint without loading output, respects wrappers, isolation and rewind', () => {
  dir = mkdtempSync(join(tmpdir(), 'checkpoint-'));
  db = openDatabase(join(dir, 'test.sqlite'));
  const host = upsertHost(db, { name: 'host', hostKeyHash: 'h'.repeat(64) });
  const create = () => createConversationThread(db, { hostId: host.id, projectId: 'p', providerId: 'codex' });
  const one = create(); const two = create();
  const add = (payload: unknown, threadId = one.id) => appendConversationThreadEvent(db, { threadId, type: 'turn/completed', payload });
  expect(getLatestConversationCheckpoint(db, one.id)).toBeNull();
  const first = add({ providerCheckpointId: ' first ' });
  add({ providerCheckpointId: 'other' }, two.id);
  add({ providerCheckpointId: 42 }); add({ providerCheckpointId: '\t\n\u00a0' }); add(null);
  expect(getLatestConversationCheckpoint(db, one.id)).toEqual({ sequence: first.sequence, checkpoint: 'first' });
  const wrapped = add({ payload: { event: { providerCheckpointId: '\n nested\ufeff' } } });
  const output = 'x'.repeat(100_000);
  db.transaction(() => { for (let i = 0; i < 300; i++) add({ output }); });
  expect(getLatestConversationCheckpoint(db, one.id)).toEqual({ sequence: wrapped.sequence, checkpoint: 'nested' });
  const direct = add({ providerCheckpointId: 'direct', event: { providerCheckpointId: 'ignored' } });
  expect(getLatestConversationCheckpoint(db, one.id)).toEqual({ sequence: direct.sequence, checkpoint: 'direct' });
  add({ event: {}, payload: { providerCheckpointId: 'ignored' } });
  expect(getLatestConversationCheckpoint(db, one.id)?.checkpoint).toBe('direct');
  deleteConversationThreadEventsAfter(db, one.id, first.sequence);
  expect(getLatestConversationCheckpoint(db, one.id)?.checkpoint).toBe('first');
  expect(getLatestConversationCheckpoint(db, two.id)?.checkpoint).toBe('other');
});
