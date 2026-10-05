// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ start: vi.fn(), page: vi.fn(), release: vi.fn() }));
vi.mock('../lib/product-client.js', () => ({ product: { history: h } }));
vi.mock('./thread/pickers/ProviderIcon.js', () => ({ ProviderIcon: () => null }));
vi.mock('./history/history-store.js', () => ({ useConversationHistory: { getState: () => ({ open() {} }) } }));
import { AgentConversationHistory } from './AgentConversationHistory';
const snapshot = (status: string) => ({ snapshotId: 'snapshot', status, rows: [], coverage: [], hasNextPage: false });
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); h.start.mockResolvedValue(snapshot('pending')); h.page.mockResolvedValue(snapshot('ready')); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
it('polls until ready without overlap and releases its snapshot on unmount', async () => {
  const pending = Promise.withResolvers<any>(); h.page.mockReturnValueOnce(pending.promise);
  const view = render(<AgentConversationHistory projectId="p" onResumed={() => {}} />);
  await act(async () => {}); await act(async () => vi.advanceTimersByTimeAsync(250));
  await act(async () => vi.advanceTimersByTimeAsync(1000)); expect(h.page).toHaveBeenCalledOnce();
  await act(async () => pending.resolve(snapshot('provisional')));
  await act(async () => vi.advanceTimersByTimeAsync(250)); expect(h.page).toHaveBeenCalledTimes(2);
  await act(async () => vi.advanceTimersByTimeAsync(1000)); expect(h.page).toHaveBeenCalledTimes(2);
  view.unmount(); expect(h.release).toHaveBeenCalledWith('snapshot'); expect(vi.getTimerCount()).toBe(0);
});
it('contains a page failure and ignores an expired or stale page after changing projects', async () => {
  h.page.mockRejectedValueOnce(Error('offline')).mockResolvedValueOnce(snapshot('expired'));
  const view = render(<AgentConversationHistory projectId="p" onResumed={() => {}} />);
  await act(async () => {}); await act(async () => vi.advanceTimersByTimeAsync(500));
  const pending = Promise.withResolvers<any>(); h.page.mockReturnValueOnce(pending.promise);
  await act(async () => vi.advanceTimersByTimeAsync(250));
  view.rerender(<AgentConversationHistory projectId="other" onResumed={() => {}} />);
  await act(async () => pending.resolve(snapshot('ready')));
  expect(h.start).toHaveBeenCalledWith({ projectId: 'other', filter: 'project' });
});
