import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { startRelay } from './server.mjs';
import { connectRelay } from './client.mjs';
import { startMobileGateway } from '../../apps/server/src/mobile/gateway.js';
import { MobileDeviceStore } from '../../apps/server/src/mobile/device-store.js';

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function listen(server: Server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return (server.address() as { port: number }).port;
}
async function setup(options: { timeout?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'zana-relay-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  let writes = 0;
  const product = createServer(async (req, res) => {
    if (req.url === '/slow') return;
    if (req.method === 'POST') writes++;
    if (req.url === '/pending') return;
    if (req.url?.startsWith('/assets/')) return res.end(Buffer.alloc(8 * 1024 * 1024, Number(req.url.split('/').at(-1))));
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    res.setHeader('content-type', 'application/octet-stream');
    res.end(chunks.length ? Buffer.concat(chunks) : 'hello from desktop');
  });
  const sockets = new WebSocketServer({ server: product });
  sockets.on('connection', ws => ws.on('message', (data, binary) => ws.send(data, { binary })));
  const productPort = await listen(product);
  cleanup.push(async () => { for (const ws of sockets.clients) ws.terminate(); sockets.close(); product.closeAllConnections(); await new Promise<void>(resolve => product.close(() => resolve())); });
  const reservation = createServer(); const port = await listen(reservation);
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const publicUrl = `http://127.0.0.1:${port}`;
  const token = randomBytes(32).toString('base64url');
  const relayOptions = { token, publicUrl, port, host: '127.0.0.1', allowLocal: true, requestTimeoutMs: options.timeout ?? 3000, heartbeatMs: 20_000 };
  let relay = await startRelay(relayOptions);
  cleanup.push(() => relay.close());
  const gateway = await startMobileGateway({ upstream: `http://127.0.0.1:${productPort}`, publicUrl, host: '127.0.0.1', port: 0, devices: new MobileDeviceStore(join(dir, 'devices.json')) });
  cleanup.push(() => gateway.close());
  const client = connectRelay({ token, publicUrl, gatewayPort: gateway.port, allowLocal: true, retryMs: 20, heartbeatMs: 20_000 });
  cleanup.push(() => client.close());
  await expect.poll(() => client.state()).toBe('connected');
  async function pair() {
    const code = gateway.pair().code;
    const paired = await fetch(`${publicUrl}/_mobile/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, label: 'Test phone' }) });
    const { credential, deviceId } = await paired.json() as { credential: string; deviceId: string };
    const session = await fetch(`${publicUrl}/_mobile/session`, { method: 'POST', headers: { authorization: `Bearer ${credential}` } });
    expect(session.status).toBe(200);
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    expect(cookie).toMatch(/^zcc_mobile_session=/);
    return { credential, deviceId, cookie };
  }
  return { publicUrl, token, relay: () => relay, client, gateway, pair, writes: () => writes,
    restart: async () => { await relay.close(); relay = await startRelay(relayOptions); await expect.poll(() => relay.connected()).toBe(true); await expect.poll(() => client.state()).toBe('connected'); } };
}

describe('mobile relay with the real authenticated gateway', () => {
  it('pairs, streams sizeable HTTP bodies, confines routes, and revokes access', async () => {
    const env = await setup();
    expect((await fetch(env.publicUrl)).status).toBe(401);
    const { cookie, deviceId } = await env.pair();
    expect(await (await fetch(env.publicUrl, { headers: { cookie } })).text()).toBe('hello from desktop');
    const body = randomBytes(512 * 1024);
    const response = await fetch(`${env.publicUrl}/api/v1/echo`, { method: 'POST', headers: { cookie }, body });
    expect(Buffer.from(await response.arrayBuffer())).toEqual(body);
    expect(env.writes()).toBe(1);
    for (const path of ['/internal/hosts/tool-call', '/mcp', '/install', '/api/admin']) expect((await fetch(env.publicUrl + path, { headers: { cookie } })).status).toBe(404);
    expect((await fetch(env.publicUrl, { headers: { cookie, origin: 'https://evil.example' } })).status).toBe(403);
    env.gateway.revoke(deviceId);
    expect((await fetch(env.publicUrl, { headers: { cookie } })).status).toBe(401);
  });
  it('forwards text and binary WebSocket frames and rejects an unpaired socket', async () => {
    const env = await setup();
    const { cookie } = await env.pair();
    const socket = new WebSocket(env.publicUrl.replace('http:', 'ws:') + '/ws', { headers: { cookie } });
    cleanup.push(() => socket.terminate());
    await once(socket, 'open');
    let received = once(socket, 'message'); socket.send('hello');
    expect((await received)[0].toString()).toBe('hello');
    received = once(socket, 'message'); const payload = randomBytes(24 * 1024); socket.send(payload);
    const [data, binary] = await received; expect(data).toEqual(payload); expect(binary).toBe(true);
    received = once(socket, 'message'); const large = randomBytes(1024 * 1024); socket.send(large);
    expect((await received)[0]).toEqual(large);
    const unauth = new WebSocket(env.publicUrl.replace('http:', 'ws:') + '/ws');
    cleanup.push(() => unauth.terminate());
    expect((await once(unauth, 'close'))[0]).toBe(1011);
  });
  it('drains concurrent large app assets without overflowing the shared tunnel', async () => {
    const env = await setup(); const { cookie } = await env.pair();
    await Promise.all(Array.from({ length: 6 }, async (_, index) => {
      const response = await fetch(`${env.publicUrl}/assets/${index}`, { headers: { cookie } });
      expect(response.status).toBe(200);
      const body = Buffer.from(await response.arrayBuffer());
      expect(body.length).toBe(8 * 1024 * 1024);
      expect(createHash('sha256').update(body).digest('hex')).toBe(createHash('sha256').update(Buffer.alloc(body.length, index)).digest('hex'));
    }));
    expect(env.client.state()).toBe('connected');
    expect((await fetch(env.publicUrl, { headers: { cookie } })).status).toBe(200);
  });
  it('survives relay restarts without re-pairing or replaying writes', async () => {
    const env = await setup(); const { cookie } = await env.pair();
    await fetch(env.publicUrl, { method: 'POST', headers: { cookie }, body: 'send once' });
    await env.restart();
    expect(await (await fetch(env.publicUrl, { headers: { cookie } })).text()).toBe('hello from desktop');
    expect(env.writes()).toBe(1);
    env.client.close();
    await expect.poll(() => env.relay().connected()).toBe(false);
    expect((await fetch(env.publicUrl)).status).toBe(503);
    expect((await fetch(`${env.publicUrl}/_relay/health`)).status).toBe(200);
  });
  it('times out a stalled response and keeps the tunnel usable', async () => {
    const env = await setup({ timeout: 100 }); const { cookie } = await env.pair();
    expect((await fetch(`${env.publicUrl}/slow`, { headers: { cookie } })).status).toBe(504);
    expect((await fetch(env.publicUrl, { headers: { cookie } })).status).toBe(200);
  });
  it('fails an interrupted write without replaying it after reconnect', async () => {
    const env = await setup(); const { cookie } = await env.pair();
    const pending = fetch(`${env.publicUrl}/pending`, { method: 'POST', headers: { cookie }, body: 'once' });
    await expect.poll(env.writes).toBe(1);
    await env.restart();
    expect((await pending).status).toBe(503);
    expect((await fetch(env.publicUrl, { headers: { cookie } })).status).toBe(200);
    expect(env.writes()).toBe(1);
  });
  it('rejects incorrect and duplicate tunnel secrets without evicting the computer', async () => {
    const env = await setup();
    for (const [token, code] of [['wrong', 401], ['é'.repeat(43), 401], [env.token, 409]] as const) {
      const ws = new WebSocket(env.publicUrl.replace('http:', 'ws:') + '/_relay/connect', { headers: { authorization: `Bearer ${token}` } });
      cleanup.push(() => ws.terminate());
      ws.on('error', () => {});
      const [, response] = await once(ws, 'unexpected-response');
      expect(response.statusCode).toBe(code); ws.terminate();
    }
    expect(env.relay().connected()).toBe(true);
  });
});
