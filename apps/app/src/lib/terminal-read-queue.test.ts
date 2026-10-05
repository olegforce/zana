import { expect, it, vi } from 'vitest';
import { createTerminalReadQueue } from './terminal-read-queue.js';
it('limits reads, drops cancelled queued jobs and releases active aborts', async () => {
  const queue = createTerminalReadQueue(1), first = new AbortController(), second = new AbortController();
  const run = vi.fn(() => new Promise<string>(() => {}));
  const active = queue(run, first.signal).catch(error => error.message);
  const pending = queue(run, second.signal).catch(error => error.message);
  second.abort(); await pending; expect(run).toHaveBeenCalledOnce();
  first.abort(); await active;
  await expect(queue(async () => 'next', new AbortController().signal)).resolves.toBe('next');
});
it('releases thrown/rejected reads, skips pre-aborted reads and bounds waiting jobs', async () => {
  const queue = createTerminalReadQueue(1), signal = new AbortController();
  await expect(queue(() => { throw new Error('sync'); }, signal.signal)).rejects.toThrow('sync');
  await expect(queue(async () => { throw new Error('async'); }, signal.signal)).rejects.toThrow('async');
  signal.abort(); await expect(queue(async () => 'no', signal.signal)).rejects.toThrow('cancelled');
  const controllers = Array.from({ length: 514 }, () => new AbortController());
  const tasks = controllers.map(controller => queue(() => new Promise(() => {}), controller.signal).catch(error => error.message));
  expect(await tasks.at(-1)).toContain('Too many');
  controllers.forEach(controller => controller.abort()); await Promise.all(tasks);
});
