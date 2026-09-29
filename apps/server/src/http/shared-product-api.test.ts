import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { startProductServer } from './product-server.js';
const invoke = vi.hoisted(() => vi.fn());
vi.mock('./cli-agent-ops.js', async original => ({ ...await original<any>(), callControlAsProductServer: invoke }));
it('accepts only bounded owner product calls and preserves authority failures without retrying', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'shared-product-api-'));
  const server = await startProductServer({ dataDir, origins: { serverPort: 0 } });
  const call = (method: string, body?: unknown, origin?: string) => fetch(`${server.url}api/v1/shared-product`, { method, headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    expect((await call('GET')).status).toBe(405);
    for (const body of [null, {}, { method: 'windows.open', args: [] }, { method: 'config.get', args: [], windowId: 1 }, { method: 'config.set', args: ['x'.repeat(128 * 1024)] }]) expect((await call('POST', body)).status).toBe(400);
    expect((await call('POST', { method: 'config.get', args: [] }, 'https://evil.example')).status).toBe(403);
    expect(invoke).not.toHaveBeenCalled();
    invoke.mockResolvedValueOnce({ ok: true, value: { theme: 'light' } });
    const accepted = await call('POST', { method: 'config.get', args: [] });
    expect(accepted.status).toBe(200); expect(await accepted.json()).toEqual({ ok: true, value: { theme: 'light' } });
    expect(invoke).toHaveBeenCalledWith(dataDir, 'product.invoke', { method: 'config.get', args: [] });
    invoke.mockResolvedValueOnce({ ok: false, code: 'UNAVAILABLE', message: 'Authority offline' });
    const failure = await call('POST', { method: 'config.set', args: [{ theme: 'dark' }] });
    expect(failure.status).toBe(503); expect(await failure.json()).toMatchObject({ ok: false, message: 'Authority offline' });
    expect(invoke).toHaveBeenCalledTimes(2);
  } finally { await server.close(); rmSync(dataDir, { recursive: true, force: true }); }
});
