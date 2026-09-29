import { afterEach, expect, it, vi } from 'vitest';
import { signInWithBrowser, SHARED_ACCOUNT } from './shared-sign-in.js';

const login = () => ({ userCode: 'u'.repeat(22), deviceCode: 'd'.repeat(43), expiresAt: Date.now() + 600_000 });
const session = () => ({ cookieValue: `${'s'.repeat(43)}.${'h'.repeat(43)}`, expiresAt: Date.now() + 3600_000 });
const deps = (...values: unknown[]) => ({ fetch: vi.fn(async () => Response.json(values.shift())), openExternal: vi.fn().mockResolvedValue(undefined) });
afterEach(() => vi.useRealTimers());

it('opens only the trusted browser approval URL and keeps secrets in main', async () => {
  const start = login(), result = session(), io = deps(start, result);
  expect(await signInWithBrowser(io, new AbortController().signal)).toEqual(result);
  expect(io.openExternal).toHaveBeenCalledExactlyOnceWith(`${SHARED_ACCOUNT}/connect/?desktop=${start.userCode}`);
  expect(io.fetch).toHaveBeenLastCalledWith(`${SHARED_ACCOUNT}/api/connect/desktop/poll/`, expect.objectContaining({ body: JSON.stringify({ deviceCode: start.deviceCode }), credentials: 'omit', redirect: 'error' }));
});
it('polls pending approvals at a bounded interval', async () => {
  vi.useFakeTimers();
  const result = session(), io = deps(login(), { pending: true }, result);
  const pending = signInWithBrowser(io, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(3000);
  expect(await pending).toEqual(result); expect(io.fetch).toHaveBeenCalledTimes(3);
});
it.each([1, 250, 59_000])('accepts valid service responses when its clock is %sms ahead', async skew => {
  vi.useFakeTimers();
  const result = { ...session(), expiresAt: Date.now() + 30 * 86400_000 + skew };
  const io = deps({ ...login(), expiresAt: Date.now() + 600_000 + skew }, result);
  expect(await signInWithBrowser(io, new AbortController().signal)).toEqual(result);
  expect(io.openExternal).toHaveBeenCalledOnce();
});
it('still rejects expirations beyond the bounded clock tolerance', async () => {
  vi.useFakeTimers();
  const io = deps({ ...login(), expiresAt: Date.now() + 660_001 });
  await expect(signInWithBrowser(io, new AbortController().signal)).rejects.toThrow('Invalid');
  expect(io.openExternal).not.toHaveBeenCalled();
  await expect(signInWithBrowser(deps(login(), { ...session(), expiresAt: Date.now() + 30 * 86400_000 + 60_001 }), new AbortController().signal)).rejects.toThrow('Invalid');
});
it('caps polling at ten local minutes even when the service clock is ahead', async () => {
  vi.useFakeTimers();
  const io = deps();
  io.fetch.mockImplementation(async () => Response.json({ pending: true }));
  io.fetch.mockResolvedValueOnce(Response.json({ ...login(), expiresAt: Date.now() + 659_000 }));
  const pending = expect(signInWithBrowser(io, new AbortController().signal)).rejects.toThrow('expired');
  await vi.advanceTimersByTimeAsync(600_000);
  await pending;
  expect(io.fetch).toHaveBeenCalledTimes(2); // No more polls after advancing the local clock to its deadline.
});
it('cancels waiting approvals and rejects late responses', async () => {
  const controller = new AbortController(), io = deps(login(), { pending: true });
  const pending = signInWithBrowser(io, controller.signal);
  const rejected = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(io.fetch).toHaveBeenCalledTimes(2));
  controller.abort(); await rejected;
  const late = new AbortController(), delayed = deps(login());
  delayed.openExternal.mockImplementation(async () => { late.abort(); });
  await expect(signInWithBrowser(delayed, late.signal)).rejects.toThrow();
  expect(delayed.fetch).toHaveBeenCalledTimes(1);
});
it('expires a pending login instead of polling indefinitely', async () => {
  vi.useFakeTimers();
  const io = deps({ ...login(), expiresAt: Date.now() + 1000 }, { pending: true });
  const pending = expect(signInWithBrowser(io, new AbortController().signal)).rejects.toThrow('expired');
  await vi.advanceTimersByTimeAsync(3000); await pending;
});
it.each([null, { userCode: 'https://evil' }, { ...login(), deviceCode: 'bad' }, { ...login(), expiresAt: 0 }, { ...login(), expiresAt: Infinity }])('refuses malformed approval responses before opening the browser (%s)', async value => {
  const io = deps(value);
  await expect(signInWithBrowser(io, new AbortController().signal)).rejects.toThrow('Invalid');
  expect(io.openExternal).not.toHaveBeenCalled();
});
it.each([null, { cookieValue: 'bad' }, { ...session(), expiresAt: 0 }, { ...session(), expiresAt: Date.now() + 31 * 86400_000 }])('rejects malformed sessions (%s)', async value => {
  await expect(signInWithBrowser(deps(login(), value), new AbortController().signal)).rejects.toThrow('Invalid');
});
it.each([403, 410, 503])('reports service failures (%s)', async status => {
  const io = deps(); io.fetch.mockImplementation(async () => new Response('', { status }));
  await expect(signInWithBrowser(io, new AbortController().signal)).rejects.toThrow(/declined|expired|unavailable/);
});
it('bounds response bodies and surfaces browser opening failures', async () => {
  for (const response of [new Response('x'.repeat(4097)), new Response(null), new Response('{')]) {
    const io = deps(); io.fetch.mockResolvedValue(response);
    await expect(signInWithBrowser(io, new AbortController().signal)).rejects.toThrow();
  }
  const io = deps(login()); io.openExternal.mockRejectedValue(new Error('No browser'));
  await expect(signInWithBrowser(io, new AbortController().signal)).rejects.toThrow('No browser');
});
