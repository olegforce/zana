import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { test, expect } from './fixtures/app.js';
import { startMobileGateway } from '../apps/server/src/mobile/gateway.js';
import { startRelay } from '../services/mobile-relay/server.mjs';
import { connectRelay } from '../services/mobile-relay/client.mjs';

test('a 16 MiB phone attachment reaches built Electron through the relay while reads remain usable', async ({ app }) => {
  test.setTimeout(120_000);
  const path = join(app.home, 'relay-upload-project'); mkdirSync(path);
  const projectId = await app.window.evaluate(async path => {
    const result = await window.cc.projects.add(path);
    if (!result.ok) throw new Error('Project registration failed');
    return result.value.id;
  }, path);
  const reservation = createServer();
  await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const publicUrl = `http://127.0.0.1:${port}`;
  const token = 'x'.repeat(43);
  const relay = await startRelay({ token, publicUrl, allowLocal: true, host: '127.0.0.1', port });
  const gateway = await startMobileGateway({ upstream: new URL(app.window.url()).origin, publicUrl, port: 0 });
  const tunnel = connectRelay({ publicUrl, token, allowLocal: true, gatewayPort: gateway.port });
  try {
    await expect.poll(relay.connected).toBe(true);
    const code = gateway.pair();
    const pair = await fetch(`${publicUrl}/_mobile/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: code.code, label: 'Relay upload E2E' }) });
    expect(pair.status).toBe(200);
    const { credential } = await pair.json();
    const session = await fetch(`${publicUrl}/_mobile/session`, { method: 'POST', headers: { authorization: `Bearer ${credential}` } });
    expect(session.status).toBe(200);
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    const data = Buffer.alloc(16 * 1024 * 1024, 42);
    const form = new FormData(); form.set('file', new Blob([data], { type: 'application/octet-stream' }), 'large.txt');
    const uploading = fetch(`${publicUrl}/api/v1/projects/${projectId}/attachments`, { method: 'POST', headers: { cookie }, body: form });
    const read = await fetch(`${publicUrl}/api/v1/projects`, { headers: { cookie } });
    expect(read.status).toBe(200); await read.arrayBuffer();
    const uploaded = await uploading; expect(uploaded.status).toBe(201);
    const attachment = await uploaded.json(); expect(attachment.sizeBytes).toBe(data.length);
    const retrieved = await fetch(`${publicUrl}/api/v1/projects/${projectId}/attachments/content?path=${encodeURIComponent(attachment.path)}`, { headers: { cookie } });
    expect(retrieved.status).toBe(200);
    const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
    expect(digest(Buffer.from(await retrieved.arrayBuffer()))).toBe(digest(data));
    expect(relay.connected()).toBe(true);
  } finally {
    tunnel.close(); await gateway.close(); await relay.close();
  }
});
