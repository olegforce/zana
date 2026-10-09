import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { summarize, classifyNoise } = vi.hoisted(() => ({ summarize: vi.fn(), classifyNoise: vi.fn() }));
vi.mock('../lib/product-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/product-client.js')>();
  return { ...actual, product: new Proxy(actual.product as object, {
    get: (target, key) => key === 'inbox' ? { ...(Reflect.get(target, key) as object), summarize, classifyNoise } : Reflect.get(target, key)
  }) };
});

import {
  INBOX_SUMMARY_AUTO_MIN_MS, maybeRefreshFeedNoise, maybeRefreshInboxSummary, refreshFeedNoise, refreshInboxSummary,
  useFeedNoise, useInboxSummary
} from './live';

const entries = [{ id: 'a', ts: 1, occurrences: 1 }] as never[];

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(1_000_000);
  summarize.mockReset(); classifyNoise.mockReset();
  useInboxSummary.setState({ byScope: {} }); useFeedNoise.setState({ byScope: {} });
});
afterEach(() => vi.useRealTimers());

describe('inbox summary auto refresh', () => {
  it('records a soft failure so a remount does not re-run the model', async () => {
    summarize.mockResolvedValue({ ok: false, reason: 'failed' });
    maybeRefreshInboxSummary('p', entries);
    await flush();
    expect(useInboxSummary.getState().byScope.p).toMatchObject({ generatedAt: null, attemptedAt: 1_000_000, error: 'failed' });
    maybeRefreshInboxSummary('p', entries);
    expect(summarize).toHaveBeenCalledOnce();
  });
  it('records an empty result and a thrown call as attempts', async () => {
    summarize.mockResolvedValueOnce({ ok: false, reason: 'empty' }).mockRejectedValueOnce(new Error('x'));
    await refreshInboxSummary('p', 's'); expect(useInboxSummary.getState().byScope.p).toMatchObject({ error: 'empty', attemptedAt: 1_000_000 });
    await refreshInboxSummary('p', 's'); expect(useInboxSummary.getState().byScope.p).toMatchObject({ error: 'failed', attemptedAt: 1_000_000 });
  });
  it('throttles changed inboxes since the latest attempt, then allows a retry; manual refresh bypasses', async () => {
    summarize.mockResolvedValue({ ok: false, reason: 'failed' });
    await refreshInboxSummary('p', 'old');
    const changed = [{ id: 'b', ts: 2, occurrences: 1 }] as never[];
    maybeRefreshInboxSummary('p', changed); expect(summarize).toHaveBeenCalledOnce();
    vi.setSystemTime(1_000_000 + INBOX_SUMMARY_AUTO_MIN_MS + 1);
    maybeRefreshInboxSummary('p', changed); expect(summarize).toHaveBeenCalledTimes(2);
    await refreshInboxSummary('p', 'manual'); expect(summarize).toHaveBeenCalledTimes(3);
  });
  it('does not start while loading and treats a success as unchanged', async () => {
    summarize.mockResolvedValue({ ok: true, digest: { items: [] } });
    useInboxSummary.getState().setItem('p', { loading: true });
    maybeRefreshInboxSummary('p', entries); expect(summarize).not.toHaveBeenCalled();
    useInboxSummary.getState().setItem('p', { loading: false });
    maybeRefreshInboxSummary('p', entries);
    await flush();
    maybeRefreshInboxSummary('p', entries); expect(summarize).toHaveBeenCalledOnce();
  });
});

describe('feed noise auto refresh', () => {
  it('is a no-op when disabled and does not re-run after a failed attempt', async () => {
    maybeRefreshFeedNoise('p', entries, false); expect(classifyNoise).not.toHaveBeenCalled();
    classifyNoise.mockRejectedValue(new Error('down'));
    maybeRefreshFeedNoise('p', entries, true);
    await flush();
    expect(useFeedNoise.getState().byScope.p?.attemptedAt).toBe(1_000_000);
    maybeRefreshFeedNoise('p', entries, true); expect(classifyNoise).toHaveBeenCalledOnce();
  });
  it('throttles a changed inbox, then retries after the window', async () => {
    classifyNoise.mockResolvedValue({ routineIds: [] });
    await refreshFeedNoise('p', 'old');
    const changed = [{ id: 'b', ts: 2, occurrences: 1 }] as never[];
    maybeRefreshFeedNoise('p', changed, true); expect(classifyNoise).toHaveBeenCalledOnce();
    vi.setSystemTime(1_000_000 + INBOX_SUMMARY_AUTO_MIN_MS + 1);
    maybeRefreshFeedNoise('p', changed, true); expect(classifyNoise).toHaveBeenCalledTimes(2);
  });
  it('keeps the routineIds Set identity when membership is unchanged', async () => {
    classifyNoise.mockResolvedValue({ routineIds: ['a', 'b'] });
    await refreshFeedNoise('p', '1');
    const first = useFeedNoise.getState().byScope.p!.routineIds;
    classifyNoise.mockResolvedValue({ routineIds: ['b', 'a'] });
    await refreshFeedNoise('p', '2');
    expect(useFeedNoise.getState().byScope.p!.routineIds).toBe(first);
    classifyNoise.mockResolvedValue({ routineIds: ['a'] });
    await refreshFeedNoise('p', '3');
    expect(useFeedNoise.getState().byScope.p!.routineIds).not.toBe(first);
    classifyNoise.mockRejectedValue(new Error('x'));
    await refreshFeedNoise('p', '4'); const empty = useFeedNoise.getState().byScope.p!.routineIds;
    expect(empty.size).toBe(0);
    await refreshFeedNoise('p', '5'); expect(useFeedNoise.getState().byScope.p!.routineIds).toBe(empty);
  });
});
