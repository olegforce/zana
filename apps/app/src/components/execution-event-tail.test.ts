import { expect, it } from 'vitest';
import { mergeExecutionEvents } from './execution-event-tail';
import type { ExecutionBoardSnapshot } from '@zana-ai/zcc-domain/product';
const snapshot = (ids: number[], truncated = false) => ({ events: ids.map(id => ({ id: String(id), payload: id })), truncated }) as unknown as ExecutionBoardSnapshot;
it('keeps only the last 500 unique events and propagates retention', () => {
  const first = snapshot(Array.from({ length: 500 }, (_, i) => i));
  const next = snapshot(Array.from({ length: 100 }, (_, i) => i + 500));
  const result = mergeExecutionEvents(first, next, 1);
  expect(result.events).toHaveLength(500); expect(result.events[0].id).toBe('100'); expect(result.truncated).toBe(true);
  expect(mergeExecutionEvents(result, snapshot([600]), 2).truncated).toBe(true);
});
it('deduplicates overlap using the newest row without claiming rows were dropped', () => {
  const result = mergeExecutionEvents(snapshot([1, 2]), snapshot([2, 3]), 1);
  expect(result.events.map(row => row.id)).toEqual(['1', '2', '3']); expect(result.truncated).toBe(false);
});
it('resets on a full snapshot and carries the backend truncation flag', () => {
  expect(mergeExecutionEvents(snapshot([1]), snapshot([9], true), 0)).toEqual(snapshot([9], true));
  expect(mergeExecutionEvents(null, snapshot([4]), 8)).toEqual(snapshot([4]));
});
