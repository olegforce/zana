import { expect, it } from 'vitest';
import { withQueuedLock } from './process-local-queued-lock.js';
it('serializes one key, releases after failure and allows independent checkouts', async () => {
  let release!: () => void; const steps: string[] = [];
  const first = withQueuedLock('a', async () => { steps.push('first'); await new Promise<void>(resolve => { release = resolve; }); throw new Error('failure'); });
  const caught = first.catch(error => { expect(error.message).toBe('failure'); });
  const second = withQueuedLock('a', async () => { steps.push('second'); });
  await withQueuedLock('b', async () => { steps.push('independent'); });
  expect(steps).toEqual(['first', 'independent']); release(); await Promise.all([caught, second]);
  await withQueuedLock('a', async () => { steps.push('third'); });
  expect(steps).toEqual(['first', 'independent', 'second', 'third']);
});
