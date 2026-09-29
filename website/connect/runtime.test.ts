import { afterEach, expect, it, vi } from 'vitest';
import { createHostedConnect, handleConnectApi } from './runtime.mjs';
import { createServer, request } from 'node:http';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('keeps existing deployments disabled and refuses incomplete or ephemeral production configuration', async () => {
  expect(await createHostedConnect({})).toBeNull();
  vi.stubEnv('CONNECT_DOMAIN', ''); expect((await handleConnectApi(new Request('https://example.com/api/connect/account'))).status).toBe(503);
  await expect(createHostedConnect({ CONNECT_DOMAIN: 'connect.example.com' })).rejects.toThrow('Set CONNECT_DOMAIN');
  await expect(createHostedConnect({ CONNECT_DOMAIN: 'connect.example.com', PUBLIC_BASE_URL: 'https://example.com', SESSION_SECRET: 'x', NODE_ENV: 'production', DATABASE_URL: ':memory:' })).rejects.toThrow('persistent Postgres');
  await expect(createHostedConnect({ CONNECT_DOMAIN: '..bad', PUBLIC_BASE_URL: 'https://example.com', SESSION_SECRET: 'x', NODE_ENV: 'test', DATABASE_URL: ':memory:' })).rejects.toThrow('Invalid Connect');
});
it('starts and closes a configured gateway and bounds unavailable Next fallback responses', async () => {
  const runtime = await createHostedConnect({ CONNECT_DOMAIN: 'connect.example.com', PUBLIC_BASE_URL: 'https://example.com', SESSION_SECRET: 'x', NODE_ENV: 'test', DATABASE_URL: ':memory:' });
  expect(runtime.connectionCount()).toBe(0); await runtime.close();
  vi.stubEnv('CONNECT_DOMAIN', 'connect.example.com'); vi.stubEnv('PUBLIC_BASE_URL', 'https://example.com'); vi.stubEnv('SESSION_SECRET', 'x'); vi.stubEnv('DATABASE_URL', ':memory:'); vi.stubEnv('NODE_ENV', 'test');
  expect((await handleConnectApi(new Request('https://example.com/api/connect/device/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"Test"}' }))).status).toBe(200);
});
it('loads the independent browser namespace from runtime configuration', async () => {
  const runtime = await createHostedConnect({ CONNECT_DOMAIN: 'connect.example.com', CONNECT_BROWSER_DOMAIN: 'example.com', PUBLIC_BASE_URL: 'https://example.com', SESSION_SECRET: 'x', NODE_ENV: 'test', DATABASE_URL: ':memory:' });
  try {
    expect(runtime.matches({ headers: { host: 'alice.example.com' }, url: '/' })).toBe(true);
    expect(runtime.matches({ headers: { host: 'example.com' }, url: '/' })).toBe(false);
    expect(runtime.matches({ headers: { host: 'www.example.com' }, url: '/' })).toBe(false);
  } finally { await runtime.close(); }
});
it.each([true, false])('registers the Slack HTTP receiver without interrupting mobile when Slack readiness is %s', async ready => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(ready ? { ok: true, team_id: 'T123456', user_id: 'U123456', bot_id: 'B123456' } : { ok: false, error: 'invalid_auth' })));
  const runtime = await createHostedConnect({ CONNECT_DOMAIN: 'connect.example.com', PUBLIC_BASE_URL: 'https://example.com', SESSION_SECRET: 'session', NODE_ENV: 'test', DATABASE_URL: ':memory:', SLACK_APP_ID: 'A123456', SLACK_TEAM_ID: 'T123456', SLACK_SIGNING_SECRET: 'signing', SLACK_BOT_TOKEN: 'private' });
  const server = createServer((req, res) => void runtime.handleHttp(req, res)); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as any).port;
  async function post(path: string, body: any, headers = {}) {
    return new Promise<any>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, method: 'POST', headers: { host: 'example.com', 'content-type': 'application/json', ...headers } }, res => { let text = ''; res.on('data', chunk => text += chunk); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) })); }); req.on('error', reject); req.end(JSON.stringify(body));
    });
  }
  try {
    const body = { type: 'url_verification', challenge: 'hello' }; const time = String(Math.floor(Date.now() / 1000));
    expect(runtime.matches({ headers: { host: 'example.com' }, url: '/api/slack/events/' })).toBe(true);
    const result = await post('/api/slack/events/', body, { 'x-slack-request-timestamp': time, 'x-slack-signature': `v0=${createHmac('sha256', 'signing').update(`v0:${time}:${JSON.stringify(body)}`).digest('hex')}` });
    expect(result).toEqual(ready ? { status: 200, body: { challenge: 'hello' } } : { status: 503, body: { error: 'slack_not_configured' } });
    expect((await post('/api/connect/device/start', { name: 'Test laptop' })).status).toBe(200);
  } finally { await runtime.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
