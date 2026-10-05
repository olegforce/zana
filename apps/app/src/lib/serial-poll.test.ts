import { afterEach, expect, it, vi } from 'vitest';
import { startSerialPoll } from './serial-poll';
afterEach(() => vi.useRealTimers());
it('never overlaps and stops on false', async () => {
  vi.useFakeTimers();
  let release!: (value: boolean) => void;
  const read = vi.fn(() => new Promise<boolean>(resolve => { release = resolve; }));
  const stop = startSerialPoll(read, 100);
  await vi.advanceTimersByTimeAsync(1000);
  expect(read).toHaveBeenCalledTimes(1);
  release(true); await vi.advanceTimersByTimeAsync(100);
  expect(read).toHaveBeenCalledTimes(2);
  release(false); await vi.advanceTimersByTimeAsync(1000);
  expect(read).toHaveBeenCalledTimes(2); stop();
});
it('retries errors and never reschedules an in-flight read after disposal', async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const read = vi.fn().mockRejectedValueOnce(new Error('offline')).mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
  const stop = startSerialPoll(read, 100, false);
  expect(read).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(200);
  expect(read).toHaveBeenCalledTimes(2); stop(); release();
  await vi.advanceTimersByTimeAsync(1000); expect(read).toHaveBeenCalledTimes(2);
});
it('cancels a pending timer', async () => {
  vi.useFakeTimers(); const read = vi.fn(); const stop = startSerialPoll(read, 100, false); stop();
  await vi.advanceTimersByTimeAsync(1000); expect(read).not.toHaveBeenCalled();
});
