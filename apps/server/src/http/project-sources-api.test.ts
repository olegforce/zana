import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { upsertHost } from '@zana-ai/zcc-db';
import { startProductServer } from './product-server.js';
import { AmbiguousHostError, HostUnavailableError } from './host-hub.js';

it('pins default branch discovery to the original machine even when another checkout is connected', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'source-branches-'));
  const server = await startProductServer({ dataDir: join(dir, 'data'), origins: { serverPort: 0 } });
  try {
    const primary = upsertHost(server.ctx.db, { name: 'Primary', hostKeyHash: 'a'.repeat(64) });
    const remote = upsertHost(server.ctx.db, { name: 'Remote', hostKeyHash: 'b'.repeat(64), isPrimary: false });
    const project = await server.ctx.projects.add(dir);
    await server.ctx.projects.addSource(project.id, { hostId: remote.id, path: '/remote/checkout' }, primary.id);
    let primaryOnline = true;
    server.ctx.hostHub.resolveHostId = vi.fn((id?: string) => {
      if (id === primary.id && !primaryOnline) throw new HostUnavailableError('Primary offline');
      if (!id && primaryOnline) throw new AmbiguousHostError();
      return id ?? remote.id;
    });
    const rpc = vi.fn(async () => ({ branches: ['main'], truncated: false }));
    server.ctx.hostHub.callHostOnlineRpc = rpc as any;
    const branches = (hostId?: string) => fetch(`${server.url}api/v1/projects/${project.id}/branches${hostId ? `?hostId=${hostId}` : ''}`);
    expect((await branches()).status).toBe(200);
    expect(rpc).toHaveBeenLastCalledWith(expect.objectContaining({ hostId: primary.id, command: expect.objectContaining({ workspacePath: project.path }) }));
    expect((await branches(remote.id)).status).toBe(200);
    expect(rpc).toHaveBeenLastCalledWith(expect.objectContaining({ hostId: remote.id, command: expect.objectContaining({ workspacePath: '/remote/checkout' }) }));
    primaryOnline = false; rpc.mockClear();
    expect((await branches()).status).toBe(503);
    expect(rpc).not.toHaveBeenCalled();
    expect((await branches(remote.id)).status).toBe(200);
  } finally { await server.close(); rmSync(dir, { recursive: true, force: true }); }
});

it('registers canonical host paths and denies unknown, busy and canonical source mutations', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'source-api-'));
  const server = await startProductServer({ dataDir: join(dir, 'data'), origins: { serverPort: 0 } });
  try {
    const primary = upsertHost(server.ctx.db, { name: 'Primary', hostKeyHash: 'a'.repeat(64) });
    const remote = upsertHost(server.ctx.db, { name: 'Remote', hostKeyHash: 'b'.repeat(64), isPrimary: false });
    const project = await server.ctx.projects.add(dir);
    const call = (method: string, suffix = '', body?: unknown) => fetch(`${server.url}api/v1/projects/${project.id}/sources${suffix}`, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    server.ctx.hostHub.ensureHostSessionReady = vi.fn() as any;
    const rpc = vi.fn(async () => ({ directory: '/canonical/remote/repo' }));
    server.ctx.hostHub.callHostOnlineRpc = rpc as any;
    expect((await call('POST', '', { hostId: randomUUID(), path: '/repo' })).status).toBe(404);
    expect((await call('POST', '', { hostId: remote.id, path: '../repo' })).status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
    const created = await call('POST', '', { hostId: remote.id, path: '/symlink/repo' });
    expect(created.status).toBe(201);
    const updated = (await created.json()).project;
    expect(updated.path).toBe(project.path);
    expect(updated.sources[0]).toMatchObject({ hostId: remote.id, path: '/canonical/remote/repo' });
    expect(rpc).toHaveBeenCalledWith({ hostId: remote.id, command: { type: 'host.browse_directory', path: '/symlink/repo' } });
    expect((await (await call('GET')).json()).sources).toHaveLength(2);
    const source = updated.sources[0];
    server.ctx.terminalSessions.set('active', { id: 'active', projectId: project.id, hostId: remote.id, status: 'running', title: 'Active', profile: 'shell', cwd: '/canonical/remote/repo', createdAt: Date.now() });
    expect((await call('DELETE', `/${source.id}`)).status).toBe(409);
    server.ctx.terminalSessions.delete('active');
    expect((await call('DELETE', `/${source.id}`)).status).toBe(200);
    expect((await call('DELETE', `/original:${project.id}`)).status).toBe(409);
    expect((await call('POST', '', { hostId: primary.id, path: '/different' })).status).toBe(409);
    rpc.mockRejectedValueOnce(new Error('offline'));
    expect((await call('POST', '', { hostId: remote.id, path: '/repo' })).status).toBe(409);
    expect((await call('PATCH')).status).toBe(405);
  } finally { await server.close(); rmSync(dir, { recursive: true, force: true }); }
});
