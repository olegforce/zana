import { test, expect, launchApp } from './fixtures/app.js';
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { mobileRelayService } from './fixtures/mobile-relay-service.js';
import { phonePortEnv } from './fixtures/phone-port.js';

test('Phone access rejects LAN setup and keeps the Heroku relay on loopback', async ({ home }, testInfo) => {
  test.setTimeout(180_000);
  const cert = join(home, 'relay-cert.pem'); const key = join(home, 'relay-key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  let relayPort = 0;
  // Heroku terminates TLS before forwarding HTTP/upgrade traffic to $PORT.
  const edge = createHttpsServer({ cert: readFileSync(cert), key: readFileSync(key) }, (req, res) => {
    const remote = httpRequest({ hostname: '127.0.0.1', port: relayPort, method: req.method, path: req.url, headers: { ...req.headers, 'x-forwarded-proto': 'https' } }, upstream => {
      res.writeHead(upstream.statusCode!, upstream.headers); upstream.pipe(res);
    });
    remote.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(remote);
  });
  const peers = new Set<import('node:net').Socket>();
  edge.on('connection', socket => { peers.add(socket); socket.on('close', () => peers.delete(socket)); });
  edge.on('upgrade', (req, socket, head) => {
    const remote = connect(relayPort, '127.0.0.1', () => {
      req.headers['x-forwarded-proto'] = 'https';
      remote.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(req.headers).map(([name, value]) => `${name}: ${value}`).join('\r\n')}\r\n\r\n`);
      if (head.length) remote.write(head);
      socket.pipe(remote).pipe(socket);
    });
    remote.on('error', () => socket.destroy()); socket.on('error', () => remote.destroy()); socket.on('close', () => remote.destroy());
  });
  edge.listen(0, '127.0.0.1'); await once(edge, 'listening');
  const publicUrl = `https://127.0.0.1:${(edge.address() as { port: number }).port}`;
  const token = randomBytes(32).toString('base64url');
  let relay = await mobileRelayService(publicUrl, token); relayPort = relay.port;
  let app: Awaited<ReturnType<typeof launchApp>> | undefined;
  async function remoteRequest(path: string, opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) {
    return new Promise<{ status: number; body: string; headers: import('node:http').IncomingHttpHeaders }>((resolve, reject) => {
      const req = httpsRequest(publicUrl + path, { ca: readFileSync(cert), method: opts.method ?? 'GET', headers: { 'content-type': 'application/json', ...opts.headers } }, res => {
        const chunks: Buffer[] = []; res.on('data', data => chunks.push(data)); res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString(), headers: res.headers }));
      });
      req.on('error', reject); req.end(opts.body ? JSON.stringify(opts.body) : undefined);
    });
  }
  async function verifyEvents(url: string, headers: Record<string, string>, change: () => Promise<unknown>) {
    const socket = new WebSocket(url, { headers, ca: readFileSync(cert), handshakeTimeout: 10_000 });
    socket.on('error', () => {});
    let received = false;
    socket.on('message', data => { if (JSON.parse(data.toString()).type === 'config:changed') received = true; });
    try {
      await once(socket, 'open');
      // Empty patch emits a real product event without changing test settings.
      await expect.poll(async () => { if (!received) await change(); return received; }).toBe(true);
    } finally { socket.terminate(); }
  }
  try {
    app = await launchApp(home, { caCertPath: cert, env: await phonePortEnv() });
    const win = app.window;
    await win.getByRole('link', { name: 'Settings', exact: true }).click();
    await win.getByTestId('settings-nav-phone').click();
    await expect(win.getByLabel('Connection method')).toHaveCount(0);
    await expect(win.getByRole('button', { name: 'Show pairing QR' })).toHaveCount(0);
    await expect(win.getByRole('link', { name: 'Get a connect code' })).toBeVisible();
    for (const mode of ['local', 'tailscale']) {
      expect(await win.evaluate(async mode => {
        try { await window.cc.mobile.configure({ mode } as never); return ''; }
        catch (error) { return String(error); }
      }, mode)).toContain('no longer supported');
    }
    await expect.poll(() => win.evaluate(() => window.cc.mobile.status())).toMatchObject({ running: false, connection: { mode: 'unconfigured' } });
    // Keep the existing relay transport covered without exposing its former LAN UI.
    await win.evaluate(async ({ publicUrl, token }) => {
      await window.cc.mobile.configure({ mode: 'relay', publicUrl, relayToken: token });
      await window.cc.config.set({ mobileGatewayEnabled: true });
    }, { publicUrl, token });
    await expect.poll(() => win.evaluate(() => window.cc.mobile.status()), { timeout: 20_000 }).toMatchObject({ host: '127.0.0.1', boundLan: false, relayState: 'connected', connection: { mode: 'relay', hasRelayToken: true } });
    if (process.env.ZCC_MOBILE_DOCKER_IMAGE) {
      // The same Docker app still serves the real Next site to ordinary visitors.
      await expect.poll(async () => (await remoteRequest('/')).status, { timeout: 30_000 }).toBe(200);
      expect((await remoteRequest('/')).body).toContain('/_next/');
      expect((await remoteRequest('/install.sh')).status).toBe(503);
    }
    expect(JSON.stringify(await win.evaluate(() => window.cc.mobile.status()))).not.toContain(token);
    expect(JSON.stringify(await win.evaluate(() => window.cc.config.get()))).not.toContain(token);
    await win.screenshot({ path: testInfo.outputPath('phone-remote-connections.png') });
    const code = (await win.evaluate(() => window.cc.mobile.pair())).code;
    const phone = JSON.parse((await remoteRequest('/_mobile/pair', { method: 'POST', body: { code, label: 'Relay fixture phone' } })).body);
    const session = await remoteRequest('/_mobile/session', { method: 'POST', headers: { authorization: `Bearer ${phone.credential}` } });
    expect(session.status).toBe(200); expect(JSON.parse(session.body).cookie.secure).toBe(true);
    const cookie = session.headers['set-cookie']![0].split(';')[0];
    await verifyEvents(publicUrl.replace('https:', 'wss:') + '/ws', { cookie, origin: publicUrl },
      () => remoteRequest('/api/v1/config', { method: 'PATCH', headers: { cookie }, body: {} }));
    const page = await remoteRequest('/', { headers: { cookie } });
    expect(page.status).toBe(200);
    const asset = page.body.match(/href="(\.?\/assets\/[^\"]+\.css)"/)?.[1];
    expect(asset).toBeTruthy();
    const downloaded = await remoteRequest(new URL(asset!, publicUrl).pathname, { headers: { cookie } });
    expect(downloaded.status).toBe(200);
    expect(Buffer.byteLength(downloaded.body)).toBeGreaterThan(8192);
    expect((await remoteRequest('/internal/hosts/tool-call', { method: 'POST', headers: { cookie } })).status).toBe(404);
    await relay.close();
    relay = await mobileRelayService(publicUrl, token, relayPort);
    await expect.poll(() => relay.connected(), { timeout: 20_000 }).toBe(true);
    expect((await remoteRequest('/', { headers: { cookie } })).status).toBe(200);
    await win.evaluate(id => window.cc.mobile.revoke(id), phone.deviceId);
    expect((await remoteRequest('/', { headers: { cookie } })).status).toBe(401);
    expect(await win.evaluate(async () => {
      try { await window.cc.mobile.configure({ mode: 'local' } as never); return ''; }
      catch (error) { return String(error); }
    })).toContain('Local-network');
    await expect.poll(() => win.evaluate(() => window.cc.mobile.status())).toMatchObject({ running: true, host: '127.0.0.1', boundLan: false, connection: { mode: 'relay' } });
    await win.evaluate(() => window.cc.config.set({ mobileGatewayEnabled: false }));
    await expect.poll(() => relay.connected()).toBe(false);
  } finally {
    await app?.electron.close(); await relay.close(); for (const socket of peers) socket.destroy();
    edge.closeAllConnections(); await new Promise<void>(resolve => edge.close(() => resolve()));
  }
});
