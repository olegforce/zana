import { afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ rows: [] as unknown[], failure: undefined as unknown }));
vi.mock('../storage/async-json-store.js', () => ({ openAsyncJsonStore: () => ({
  get: async () => state.rows,
  set: async (_key: string, rows: unknown[]) => { if (state.failure !== undefined) throw state.failure; state.rows = rows; },
  delete: async () => { if (state.failure !== undefined) throw state.failure; state.rows = []; },
  dispose: () => {}
}) }));
import { closeQueuedMessages, createQueuedMessage, deleteQueuedMessage, listQueuedMessages } from './queued-messages.js';
const input = [{ type: 'text' as const, text: 'queued', mentions: [] }];
afterEach(() => { closeQueuedMessages('/fixture'); state.rows = []; state.failure = undefined; });
it.each([
  [new Error('quota exceeded'), 413, 'queue-limit'], ['value exceeds cap', 413, 'queue-limit'],
  [new Error('worker busy'), 503, 'queue-busy'], ['capacity exhausted', 503, 'queue-busy'],
  [new Error('request timed out'), 503, 'queue-busy']
])('maps storage failure %s and permits the next edit to settle', async (failure, status, code) => {
  state.failure = failure;
  await expect(createQueuedMessage('/fixture', 'thread', input)).rejects.toMatchObject({ status, code });
  state.failure = undefined;
  const row = await createQueuedMessage('/fixture', 'thread', input);
  await deleteQueuedMessage('/fixture', 'thread', row.id);
  expect(await listQueuedMessages('/fixture', 'thread')).toEqual([]);
});
it('preserves unexpected persistence failures without overwriting the queue', async () => {
  const failure = new Error('disk unavailable'); state.failure = failure;
  await expect(createQueuedMessage('/fixture', 'thread', input)).rejects.toBe(failure);
  expect(state.rows).toEqual([]);
});
it('rejects the 101st queued message before storage writes', async () => {
  state.rows = Array.from({ length: 100 }, () => ({}));
  await expect(createQueuedMessage('/fixture', 'thread', input)).rejects.toMatchObject({ status: 413, code: 'queue-limit' });
  expect(state.rows).toHaveLength(100);
});
