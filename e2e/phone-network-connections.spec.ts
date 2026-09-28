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

test('Phone settings supports local, Tailscale HTTPS and a reconnecting Heroku-style relay', async ({ home }, testInfo) => {
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
    const method = win.getByLabel('Connection method');
    await expect(method).toHaveValue('local');
    await method.selectOption('tailscale');
    await win.getByLabel('Tailscale HTTPS address').fill('https://mac.example.ts.net');
    await win.getByRole('button', { name: 'Save connection', exact: true }).click();
    await expect.poll(() => win.evaluate(() => window.cc.mobile.status())).toMatchObject({ connection: { mode: 'tailscale' } });
    await win.getByRole('switch', { name: 'Enable phone access' }).click();
    await expect.poll(() => win.evaluate(() => window.cc.mobile.status())).toMatchObject({ running: true, host: '127.0.0.1', publicUrl: 'https://mac.example.ts.net' });
    const payload = await win.evaluate(() => window.cc.mobile.pair());
    expect(payload.serverUrl).toBe('https://mac.example.ts.net');
    const status = await win.evaluate(() => window.cc.mobile.status());
    // This is the last hop used by Tailscale Serve, preserving the HTTPS host.
    const tailscaleHop = (path: string, body: unknown, extra: Record<string, string> = {}) => new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port: status.port!, path, method: 'POST', headers: { host: 'mac.example.ts.net', 'content-type': 'application/json', ...extra } }, res => {
        const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString() }));
      });
      req.on('error', reject); req.end(JSON.stringify(body));
    });
    const paired = await tailscaleHop('/_mobile/pair', { code: payload.code, label: 'Tailscale fixture phone' });
    expect(paired.status).toBe(200);
    const credential = JSON.parse(paired.body).credential;
    const secureSession = await tailscaleHop('/_mobile/session', {}, { authorization: `Bearer ${credential}` });
    const tailscaleCookie = JSON.parse(secureSession.body).cookie;
    expect(tailscaleCookie.secure).toBe(true);
    const tailscaleHeaders = { host: 'mac.example.ts.net', cookie: `${tailscaleCookie.name}=${tailscaleCookie.value}` };
    await verifyEvents(`ws://127.0.0.1:${status.port}/ws`, tailscaleHeaders, () => tailscaleHop('/api/v1/config', {}, tailscaleHeaders));

    await method.selectOption('relay');
    await win.getByLabel('Relay HTTPS address').fill(publicUrl);
    await win.getByLabel('Relay secret').fill(token);
    await win.getByRole('button', { name: 'Save connection', exact: true }).click();
    await expect.poll(() => win.evaluate(() => window.cc.mobile.status()), { timeout: 20_000 }).toMatchObject({ relayState: 'connected', connection: { mode: 'relay', hasRelayToken: true } });
    await expect(win.getByText('Relay connected', { exact: true })).toBeVisible();
    await expect(win.getByRole('button', { name: 'Show pairing QR', exact: true })).toBeEnabled();
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
    await method.selectOption('local');
    await win.getByRole('button', { name: 'Save connection', exact: true }).click();
    await expect.poll(() => win.evaluate(() => window.cc.mobile.status())).toMatchObject({ running: true, connection: { mode: 'local' } });
    await expect.poll(() => relay.connected()).toBe(false);
    // Exercise the selected LAN interface too, including pairing and revocation.
    const local = await win.evaluate(() => window.cc.mobile.status());
    const localCode = (await win.evaluate(() => window.cc.mobile.pair())).code;
    const localPhone = await (await fetch(local.publicUrl! + '/_mobile/pair', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: localCode, label: 'LAN fixture phone' })
    })).json() as { credential: string; deviceId: string };
    const localSession = await fetch(local.publicUrl! + '/_mobile/session', {
      method: 'POST', headers: { authorization: `Bearer ${localPhone.credential}` }
    });
    expect(localSession.status).toBe(200);
    const localCookie = localSession.headers.get('set-cookie')!.split(';')[0];
    await verifyEvents(local.publicUrl!.replace('http:', 'ws:') + '/ws', { cookie: localCookie },
      () => fetch(local.publicUrl! + '/api/v1/config', { method: 'PATCH', headers: { cookie: localCookie, 'content-type': 'application/json' }, body: '{}' }));
    expect((await fetch(local.publicUrl!, { headers: { cookie: localCookie } })).status).toBe(200);
    await win.evaluate(id => window.cc.mobile.revoke(id), localPhone.deviceId);
    expect((await fetch(local.publicUrl!, { headers: { cookie: localCookie } })).status).toBe(401);
  } finally {
    await app?.electron.close(); await relay.close(); for (const socket of peers) socket.destroy();
    edge.closeAllConnections(); await new Promise<void>(resolve => edge.close(() => resolve()));
  }
});
