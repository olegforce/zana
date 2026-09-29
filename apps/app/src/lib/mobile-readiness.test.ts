// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { reportMobileReadiness } from './mobile-readiness.js';
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('reports from the mounted shell with cookies, a stable instance and cleanup', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockResolvedValue(new Response('{}'));
  vi.stubGlobal('fetch', fetcher);
  const stop = reportMobileReadiness('ios', '2.3.0');
  await vi.advanceTimersByTimeAsync(10_000);
  expect(fetcher).toHaveBeenCalledTimes(2);
  const first = fetcher.mock.calls[0];
  expect(first[0]).toBe('/_zcc/mobile-ready');
  expect(first[1].credentials).toBe('same-origin');
  expect(JSON.parse(first[1].body)).toMatchObject({ platform: 'ios', appVersion: '2.3.0', instanceId: expect.stringMatching(/^[a-f0-9]{32}$/) });
  expect(fetcher.mock.calls[1][1].body).toBe(first[1].body);
  stop(); await vi.advanceTimersByTimeAsync(60_000);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('does not overlap requests, aborts a stalled report, and skips hidden pages', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockImplementation(() => new Promise(() => {}));
  vi.stubGlobal('fetch', fetcher);
  const stop = reportMobileReadiness('android', '2.3.0');
  await vi.advanceTimersByTimeAsync(20_000);
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
  stop();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  const hiddenStop = reportMobileReadiness('ios', '2.3.0');
  await vi.advanceTimersByTimeAsync(10_000);
  expect(fetcher).toHaveBeenCalledOnce(); hiddenStop();
});
it('tolerates offline and older gateways and retries later', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(new Response('{}', { status: 404 }));
  vi.stubGlobal('fetch', fetcher);
  const stop = reportMobileReadiness('ios', '2.3.0');
  await vi.advanceTimersByTimeAsync(10_000);
  expect(fetcher).toHaveBeenCalledTimes(2); stop();
});
