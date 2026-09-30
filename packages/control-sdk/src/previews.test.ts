import { afterEach, expect, it, vi } from 'vitest';
import { Zcc } from './client.js';
afterEach(() => vi.unstubAllEnvs());
it('lists, shares and stops previews through the authenticated product API client', async () => {
  vi.stubEnv('ZCC_SESSION_ID', ''); vi.stubEnv('ZCC_SESSION_TOKEN', '');
  const fetchImpl = vi.fn(async (url: URL | RequestInfo, _init?: RequestInit) => new Response(JSON.stringify(String(url).endsWith('/health') ? { ok: true } : { enabled: true, shares: [] })));
  const zcc = await Zcc.connect({ serverUrl: 'http://127.0.0.1:8780', fetchImpl });
  expect(await zcc.previews.list()).toEqual({ enabled: true, shares: [] });
  await zcc.previews.share({ port: 5173, hostId: 'machine' });
  expect(fetchImpl.mock.calls.at(-1)?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ port: 5173, hostId: 'machine' }) });
  await zcc.previews.stop({ port: 5173 });
  expect(fetchImpl.mock.calls.at(-1)?.[1]).toMatchObject({ method: 'DELETE', body: JSON.stringify({ port: 5173 }) });
});
