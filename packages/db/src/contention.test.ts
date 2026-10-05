import { afterEach, expect, it, vi } from 'vitest';
import { isSqliteBusy, retrySqliteTransaction } from './contention';
afterEach(() => vi.useRealTimers());
it.each(['SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT', 'SQLITE_LOCKED', 'SQLITE_LOCKED_SHAREDCACHE'])('recognizes %s', code => expect(isSqliteBusy({ code })).toBe(true));
it.each([null, new Error('busy'), { code: 'SQLITE_ERROR' }])('does not retry other failures', error => expect(isSqliteBusy(error)).toBe(false));
it('retries atomic busy operations while allowing other timers to run', async () => {
  let busy = true; let ticks = 0; const timer = setInterval(() => ticks++, 1); setTimeout(() => { busy = false; }, 45);
  try { const result = await retrySqliteTransaction(() => { if (busy) throw { code: 'SQLITE_BUSY' }; return 42; }); expect(result).toBe(42); expect(ticks).toBeGreaterThan(5); } finally { clearInterval(timer); }
});
it('honors the retry deadline and immediately throws non-busy failures', async () => {
  vi.useFakeTimers(); const busy = { code: 'SQLITE_BUSY' }; const fn = vi.fn(() => { throw busy; });
  const result = expect(retrySqliteTransaction(fn, 40)).rejects.toBe(busy); await vi.advanceTimersByTimeAsync(50); await result; expect(fn.mock.calls.length).toBeLessThan(8);
  const error = new Error('invalid'); await expect(retrySqliteTransaction(() => { throw error; })).rejects.toBe(error);
});
