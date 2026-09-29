import { expect, it, vi } from 'vitest';
import type { ProductTerminalRecord } from './product-context.js';
import { recoverFailedTerminalStart } from './terminal-start-recovery.js';
const record = (): ProductTerminalRecord => ({ id: 's', hostId: 'h', projectId: 'p', profile: 'shell', title: 'shell', cwd: '/repo', status: 'starting', createdAt: 1 });
it('closes a possibly-started process without retrying it or discarding ownership', async () => {
  const row = record(), stop = vi.fn(async () => undefined);
  await recoverFailedTerminalStart(row, stop);
  expect(stop).toHaveBeenCalledOnce();
  expect(row).toMatchObject({ id: 's', hostId: 'h', status: 'exited', finishedAt: expect.any(Number) });
});
it('retains the original owner and unresolved state while offline', async () => {
  const row = record();
  await recoverFailedTerminalStart(row, async () => { throw new Error('offline'); });
  expect(row).toEqual(record());
});
it('preserves a natural exit received before the acknowledgement failed', async () => {
  const row = { ...record(), status: 'exited' as const, finishedAt: 10 };
  await recoverFailedTerminalStart(row, async () => undefined);
  expect(row.finishedAt).toBe(10);
  await recoverFailedTerminalStart(row, async () => { throw new Error('offline'); });
  expect(row).toMatchObject({ status: 'exited', finishedAt: 10 });
});
