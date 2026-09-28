// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { InboxEntry } from '@zana-ai/zcc-domain/product';
import type { InboxThread } from '../lib/inbox-thread.js';

const resolve = vi.hoisted(() => vi.fn());
vi.mock('../lib/inbox-thread.js', () => ({ resolveInboxThread: resolve }));
import { useInboxThread } from './useInboxThread.js';
const entry = (id: string): InboxEntry => ({ id, projectId: 'p', ts: 1, sessionId: id });
beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);

it.each(['resolve', 'reject'])('ignores a stale lookup after changing reports (%s)', async (settlement) => {
  let finish!: (thread: InboxThread) => void;
  let fail!: (error: Error) => void;
  resolve.mockReturnValueOnce(new Promise((yes, no) => { finish = yes; fail = no; }));
  resolve.mockResolvedValueOnce({ id: 'second', title: 'Second', archived: false });
  const { result, rerender } = renderHook(({ id }) => useInboxThread(entry(id), false), { initialProps: { id: 'first' } });
  rerender({ id: 'second' });
  await waitFor(() => expect(result.current.thread?.id).toBe('second'));
  await act(async () => {
    if (settlement === 'resolve') finish({ id: 'first', title: 'First', archived: false });
    else fail(new Error('Stale error'));
  });
  expect(result.current.thread?.id).toBe('second');
  expect(result.current.error).toBeNull();
});

it('shows a useful message for non-Error failures', async () => {
  resolve.mockRejectedValue('offline');
  const { result } = renderHook(() => useInboxThread(entry('thread'), false));
  await waitFor(() => expect(result.current.error).toBe('Could not load the original conversation.'));
});
