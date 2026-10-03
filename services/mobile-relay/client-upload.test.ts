import { expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { WebSocket } from 'ws';
import { startRelay } from './server.mjs';
import { connectRelay } from './client.mjs';

it.each(['drain', 'close'] as const)('keeps a slow upload bounded when the gateway drains or the tunnel closes (%s)', async mode => {
  const pause = vi.spyOn(WebSocket.prototype, 'pause');
  const data = Buffer.alloc(16 * 1024 * 1024, 42);
  const digest = (body: Buffer) => createHash('sha256').update(body).digest('hex');
  let resumeTimer: ReturnType<typeof setTimeout> | undefined;
  const gateway = createServer((req, res) => {
    if (req.method === 'GET') { res.end('ready'); return; }
    const hash = createHash('sha256');
    let size = 0;
    req.on('data', chunk => { size += chunk.length; hash.update(chunk); });
    req.on('end', () => { res.writeHead(201); res.end(JSON.stringify({ size, digest: hash.digest('hex') })); });
    req.pause();
    resumeTimer = setTimeout(() => req.resume(), 500);
  });
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  const gatewayPort = (gateway.address() as { port: number }).port;
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const publicUrl = `http://127.0.0.1:${port}`;
  const token = 'x'.repeat(43);
  const relay = await startRelay({ token, publicUrl, allowLocal: true, host: '127.0.0.1', port });
  const client = connectRelay({ token, publicUrl, allowLocal: true, gatewayPort });
  try {
    await expect.poll(client.state).toBe('connected');
    const upload = fetch(publicUrl + '/upload', { method: 'POST', body: data });
    const read = await fetch(publicUrl + '/read');
    expect(await read.text()).toBe('ready');
    if (mode === 'close') {
      await expect.poll(() => (pause.mock.contexts as WebSocket[]).some(socket => socket.isPaused)).toBe(true);
      const blocked = (pause.mock.contexts as WebSocket[]).find(socket => socket.isPaused)!;
      client.close();
      expect(blocked.isPaused).toBe(false);
      expect((await upload).status).toBe(503);
      expect(client.state()).toBe('stopped');
      return;
    }
    const response = await upload;
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ size: data.length, digest: digest(data) });
    expect(client.state()).toBe('connected');
  } finally {
    clearTimeout(resumeTimer);
    client.close(); await relay.close();
    gateway.closeAllConnections();
    await new Promise<void>(resolve => gateway.close(() => resolve()));
    pause.mockRestore();
  }
}, 15_000);
