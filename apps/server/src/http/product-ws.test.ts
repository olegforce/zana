import { afterEach, describe, expect, it } from 'vitest';
import { startProductServer, type ProductServer } from './product-server.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

let server: ProductServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

describe('product /ws', () => {
  it('answers client heartbeats without exposing arbitrary client messages to the hub', async () => {
    server = await startProductServer({ dataDir: mkdtempSync(join(tmpdir(), 'zcc-product-ping-')), origins: { serverPort: 0, devAppPort: 5173 } });
    const reply = await new Promise<unknown>((resolve, reject) => {
      const ws = new WebSocket(server!.url.replace(/^http/, 'ws') + 'ws', { origin: 'http://localhost:5173' });
      ws.on('open', () => { ws.send('{"type":"scheduler:command"}'); ws.send('{"type":"ping"}'); });
      ws.on('message', raw => { resolve(JSON.parse(String(raw))); ws.close(); });
      ws.on('error', reject);
    });
    expect(reply).toEqual({ type: 'pong' });
  });
  it('accepts a loopback upgrade and rejects a foreign Origin', async () => {
    server = await startProductServer({
      dataDir: mkdtempSync(join(tmpdir(), 'zcc-product-ws-')),
      origins: { serverPort: 0, devAppPort: 5173 }
    });
    const wsUrl = server.url.replace(/^http/, 'ws') + 'ws';

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl, { origin: 'http://localhost:5173' });
      ws.on('open', () => {
        ws.close();
        resolve();
      });
      ws.on('error', reject);
    });

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl, { origin: 'https://evil.example' });
      ws.on('open', () => reject(new Error('foreign origin was accepted')));
      ws.on('unexpected-response', (_req, res) => {
        expect(res.statusCode).toBe(403);
        res.resume();
        resolve();
      });
      ws.on('error', () => {
        resolve();
      });
    });
  });

  it('forwards threads:event frames to the browser', async () => {
    server = await startProductServer({
      dataDir: mkdtempSync(join(tmpdir(), 'zcc-product-ws-event-')),
      origins: { serverPort: 0, devAppPort: 5173 }
    });
    const wsUrl = server.url.replace(/^http/, 'ws') + 'ws';
    const received = await new Promise<unknown>((resolve, reject) => {
      const ws = new WebSocket(wsUrl, { origin: 'http://localhost:5173' });
      ws.on('message', (raw) => {
        ws.close();
        resolve(JSON.parse(String(raw)));
      });
      ws.on('open', () => {
        server!.ctx.hub.emit('threads:event', {
          threadId: '11111111-1111-4111-8111-111111111111',
          kind: 'terminal.output',
          payload: { data: 'hi' }
        });
      });
      ws.on('error', reject);
    });
    expect(received).toEqual({
      type: 'threads:event',
      payload: {
        threadId: '11111111-1111-4111-8111-111111111111',
        kind: 'terminal.output',
        payload: { data: 'hi' }
      }
    });
  });
});
