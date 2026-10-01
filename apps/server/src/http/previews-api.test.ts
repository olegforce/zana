import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProductServer, type ProductServer } from './product-server.js';
import { upsertHost } from '@zana-ai/zcc-db';
let server: ProductServer, dir: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'preview-api-'));
  server = await startProductServer({ dataDir: dir, origins: { serverPort: 0 }, port: 0 });
  upsertHost(server.ctx.db, { name: 'Local', hostKeyHash: 'a'.repeat(64) });
});
afterEach(async () => { await server.close(); rmSync(dir, { recursive: true, force: true }); });
const call = (method: string, body?: unknown, headers: Record<string, string> = {}) => fetch(`${server.url}api/v1/previews`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
it('serves status and validates mutation scope, port and enabled state', async () => {
  expect(await (await call('GET')).json()).toEqual({ enabled: false, shares: [] });
  expect((await call('POST', { port: 22 })).status).toBe(400);
  expect((await call('POST', { port: 5173, targetHost: 'forged' })).status).toBe(400);
  const off = await call('POST', { port: 5173 }); expect(off.status).toBe(409); expect(await off.text()).toContain('Remote access');
  expect((await call('DELETE', { port: 5173 })).status).toBe(200);
  expect((await call('PUT', {})).status).toBe(405);
});
it('refuses agent identity markers and cross-origin mutations', async () => {
  expect((await call('GET', undefined, { 'x-zcc-caller-session-id': 'forged' })).status).toBe(403);
  expect((await call('POST', { port: 5173 }, { 'x-zcc-caller-credential': 'forged' })).status).toBe(403);
  expect((await call('POST', { port: 5173 }, { origin: 'https://evil.test' })).status).toBe(403);
});
