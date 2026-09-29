import { afterEach, expect, it, vi } from 'vitest';
import { startConversationHistoryMaintenance } from './conversation-history-maintenance.js';
import { maintainConversationHistory, maintainConversationEventHistory, type ZccDatabase } from '@zana-ai/zcc-db';
vi.mock('@zana-ai/zcc-db', () => ({ maintainConversationHistory: vi.fn(), maintainConversationEventHistory: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
it('survives a transient failure and disposes its single timer', () => {
  vi.useFakeTimers();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.mocked(maintainConversationHistory).mockImplementationOnce(() => { throw new Error('busy'); })
    .mockImplementationOnce(() => { throw 'busy'; });
  const stop = startConversationHistoryMaintenance({} as ZccDatabase);
  expect(maintainConversationHistory).not.toHaveBeenCalled();
  vi.advanceTimersByTime(30_000);
  expect(warn).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(30_000);
  expect(maintainConversationHistory).toHaveBeenCalledTimes(2);
  expect(maintainConversationEventHistory).not.toHaveBeenCalled();
  vi.advanceTimersByTime(30_000);
  expect(maintainConversationEventHistory).toHaveBeenCalledOnce();
  stop();
  vi.advanceTimersByTime(60_000);
  expect(maintainConversationHistory).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(0);
});
