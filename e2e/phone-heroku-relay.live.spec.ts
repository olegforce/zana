import { test, expect, launchApp } from './fixtures/app.js';
import { phonePortEnv } from './fixtures/phone-port.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { WebSocket } from 'ws';

// Explicit opt-in: this occupies the configured relay with an isolated desktop.
// Read the secret through the environment; never place it in traces or argv.
test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test('Phone relay works through live Heroku HTTPS and WebSockets', async ({ home }) => {
  const publicUrl = process.env.ZCC_LIVE_MOBILE_RELAY_URL;
  const relayToken = process.env.ZCC_LIVE_MOBILE_RELAY_TOKEN;
  test.skip(!publicUrl || !relayToken, 'requires an explicitly configured live mobile relay');
  test.setTimeout(270_000);
  expect(new URL(publicUrl!).protocol).toBe('https:');
  const remote = (path: string, init: RequestInit = {}) => fetch(publicUrl + path, {
    ...init, signal: AbortSignal.timeout(25_000)
  });
  const health = await remote('/_relay/health');
  expect(health.status).toBe(200);
  expect((await health.json()).connected, 'do not replace an existing desktop tunnel').toBe(false);
  expect((await remote('/')).status).toBe(200);

  const mobileDir = join(home, '.zcc', 'mobile');
  mkdirSync(mobileDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(mobileDir, 'connection.json'), JSON.stringify({
    mode: 'relay', publicUrl, relayToken
  }), { mode: 0o600 });
  delete process.env.ZCC_LIVE_MOBILE_RELAY_TOKEN;
  const app = await launchApp(home, { initialConfig: { mobileGatewayEnabled: true }, env: await phonePortEnv() });
  let socket: WebSocket | undefined;
  try {
    await expect.poll(() => app.window.evaluate(() => window.cc.mobile.status()), { timeout: 45_000 })
      .toMatchObject({ running: true, host: '127.0.0.1', relayState: 'connected' });
    expect((await remote('/api/v1/config')).status).toBe(401);
    const { code } = await app.window.evaluate(() => window.cc.mobile.pair());
    const paired = await remote('/_mobile/pair', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, label: 'Heroku live regression' })
    });
    expect(paired.status).toBe(200);
    const phone = await paired.json() as { credential: string; deviceId: string };
    const session = await remote('/_mobile/session', {
      method: 'POST', headers: { authorization: `Bearer ${phone.credential}` }
    });
    expect(session.status).toBe(200);
    const setCookie = session.headers.get('set-cookie')!;
    expect(setCookie.includes('Secure')).toBe(true);
    expect(setCookie.includes('HttpOnly')).toBe(true);
    const cookie = setCookie.split(';')[0];
    const headers = { cookie, origin: publicUrl! };
    const page = await remote('/', { headers });
    expect(page.status).toBe(200);
    const html = await page.text();
    const asset = html.match(/href="(\.?\/assets\/[^\"]+\.css)"/)?.[1];
    expect(Boolean(asset)).toBe(true);
    const downloaded = await remote(new URL(asset!, publicUrl).pathname, { headers });
    expect(downloaded.status).toBe(200);
    expect((await downloaded.arrayBuffer()).byteLength).toBeGreaterThan(8192);
    expect((await remote('/internal/hosts/tool-call', { method: 'POST', headers })).status).toBe(404);

    let events = 0;
    let pings = 0;
    const openEvents = async () => {
      socket = new WebSocket(publicUrl!.replace('https:', 'wss:') + '/ws', {
        headers, handshakeTimeout: 20_000
      });
      socket.on('error', () => {});
      socket.on('ping', () => { pings++; });
      socket.on('message', data => {
        if (JSON.parse(data.toString()).type === 'config:changed') events++;
      });
      await once(socket, 'open');
    };
    await openEvents();
    const verifyEvent = async () => {
      const before = events;
      await expect.poll(async () => {
        if (events === before) {
          const change = await remote('/api/v1/config', {
            method: 'PATCH', headers: { ...headers, 'content-type': 'application/json' }, body: '{}'
          });
          expect(change.status).toBe(200);
        }
        return events > before;
      }, { timeout: 15_000 }).toBe(true);
    };
    await verifyEvent();
    await test.step('Heartbeats preserve the idle connection beyond the router timeout', async () => {
      await new Promise(resolve => setTimeout(resolve, 65_000));
      expect(socket!.readyState).toBe(WebSocket.OPEN);
      expect(pings).toBeGreaterThanOrEqual(2);
      await verifyEvent();
    });

    const herokuApp = process.env.ZCC_LIVE_HEROKU_RESTART_APP;
    if (herokuApp) {
      await test.step('Reconnect after an explicitly requested Heroku dyno restart', async () => {
        execFileSync('heroku', ['ps:restart', 'web.1', '--app', herokuApp], {
          encoding: 'utf8', timeout: 30_000, stdio: 'pipe'
        });
        await expect.poll(() => socket!.readyState, { timeout: 30_000 }).toBe(WebSocket.CLOSED);
        await expect.poll(async () => {
          try {
            const response = await remote('/_relay/health');
            return response.status === 200 && (await response.json()).connected;
          } catch { return false; }
        }, { timeout: 90_000 }).toBe(true);
        expect((await remote('/', { headers })).status).toBe(200);
        await openEvents();
        await verifyEvent();
      });
    }
    await app.window.evaluate(id => window.cc.mobile.revoke(id), phone.deviceId);
    expect((await remote('/', { headers })).status).toBe(401);
    expect((await remote('/')).status).toBe(200);
  } finally {
    socket?.terminate();
    await app.electron.close();
  }
  await expect.poll(async () => (await (await remote('/_relay/health')).json()).connected).toBe(false);
});
