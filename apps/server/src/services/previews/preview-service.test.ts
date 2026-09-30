import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, upsertHost, createEnvironment, createConversationThread } from '@zana-ai/zcc-db';
import { PreviewService } from './preview-service.js';

const h = vi.hoisted(() => ({ connect: vi.fn(), request: vi.fn(), protected: vi.fn(() => false), state: 'connected', close: vi.fn() }));
vi.mock('../../../../../services/mobile-relay/client.mjs', () => ({ connectRelay: h.connect }));
vi.mock('../../../../../services/mobile-relay/protected-ports.mjs', () => ({ isProtectedPreviewPort: h.protected, protectPreviewPort: () => () => {} }));
vi.mock('../../mobile/connect-account.js', () => ({ connectRequest: h.request }));
let dir: string, db: ReturnType<typeof openDatabase>, ctx: any, service: PreviewService, local: string, remote: string;
let enabled: boolean;
function thread(hostId = local) { const environment = createEnvironment(db, { projectId: 'project', hostId, path: dir + Math.random() }); return createConversationThread(db, { projectId: 'project', hostId, environmentId: environment.id, providerId: 'codex' }).id; }
beforeEach(async () => {
  vi.clearAllMocks(); h.state = 'connected'; h.protected.mockReturnValue(false); enabled = true;
  h.connect.mockImplementation(() => ({ state: () => h.state, close: h.close }));
  h.request.mockResolvedValue({ servers: [{ id: 'server', browserUrl: 'https://alice.example.com' }] });
  dir = mkdtempSync(join(tmpdir(), 'previews-')); db = openDatabase(join(dir, 'db.sqlite'));
  local = upsertHost(db, { name: 'Laptop', hostKeyHash: 'a'.repeat(64) }).id;
  remote = upsertHost(db, { name: 'Remote', hostKeyHash: 'b'.repeat(64) }).id;
  mkdirSync(join(dir, 'mobile')); writeFileSync(join(dir, 'mobile/connection.json'), JSON.stringify({ mode: 'connect', serverId: 'server', accountUrl: 'https://example.com', publicUrl: 'https://server.example.com', relayToken: 'a'.repeat(43) }));
  ctx = { db, dataDir: dir, config: { getConfig: () => ({ mobileGatewayEnabled: enabled }) }, hostHub: { resolveHostId: (id: string) => { if (![local, remote].includes(id)) throw new Error('Unknown host'); return id; }, connectedHostIds: () => [local, remote], callHostOnlineRpc: vi.fn(async () => ({ state: 'connected', unavailablePorts: [] })) } };
  service = new PreviewService(ctx); await service.reconcile(); await Promise.resolve();
});
afterEach(() => { service.dispose(); db.close(); rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

it('serializes independent owners, renews leases, and stops only the requesting thread', async () => {
  vi.spyOn(service as any, 'probe').mockResolvedValue(false);
  const a = thread(), b = thread();
  await Promise.all([service.change({ port: 5173 }, false, a), service.change({ port: 5173 }, false, b)]);
  expect((await service.list()).shares[0]).toMatchObject({ hostId: local, leases: 2, url: 'https://alice--5173.example.com', status: 'server-not-responding' });
  await service.change({ port: 5173 }, false, a);
  expect((await service.list()).shares[0].leases).toBe(2);
  await service.change({ port: 5173 }, true, a); expect((await service.list()).shares[0].leases).toBe(1);
  await service.change({ port: 5173 }, true, b); expect((await service.list()).shares).toEqual([]); expect(h.close).toHaveBeenCalled();
  expect(JSON.parse(readFileSync(join(dir, 'previews/leases.json'), 'utf8'))).toEqual([]);
});
it('operator stop revokes all owners and saved leases survive a service restart', async () => {
  await service.change({ port: 3000 }, false, thread()); await service.change({ port: 3000 });
  service.dispose(); service = new PreviewService(ctx);
  expect((await service.list()).shares[0].leases).toBe(2);
  expect((await service.change({ port: 3000 }, true)).shares).toEqual([]);
});
it('confines thread scope, validates ports and denies protected ports', async () => {
  await expect(service.change({ port: 3000, hostId: remote }, false, thread())).rejects.toThrow('match this thread');
  await expect(service.change({ port: 3000 }, false, 'forged')).rejects.toThrow('match this thread');
  await expect(service.change({ port: 22 })).rejects.toThrow();
  h.protected.mockReturnValue(true); await expect(service.change({ port: 8780 })).rejects.toThrow('protected');
});
it('expires leases and removes archived threads', async () => {
  const id = thread(); await service.change({ port: 5173 }, false, id);
  db.sqlite.prepare('UPDATE threads SET archived_at=? WHERE id=?').run(Date.now(), id);
  expect((await service.list()).shares).toEqual([]);
  await service.change({ port: 3000 });
  const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 9 * 60 * 60_000);
  expect((await service.list()).shares).toEqual([]);
});
it('remote declarations carry generation, preserve machine isolation and report availability', async () => {
  const remoteThread = thread(remote); await service.change({ port: 3000 });
  await service.change({ port: 5173 }, false, remoteThread); await service.reconcile();
  expect(ctx.hostHub.callHostOnlineRpc).toHaveBeenCalledWith(expect.objectContaining({ hostId: remote, command: expect.objectContaining({ type: 'preview.replace', generation: expect.any(Number), targets: [expect.objectContaining({ port: 5173 })] }) }));
  expect((await service.list(remoteThread)).shares[0]).toMatchObject({ hostId: remote, status: 'ready', url: expect.stringMatching(/^https:\/\/alice--[0-9a-f]{16}--5173.example.com$/) });
  expect((await service.list(remoteThread)).shares).toHaveLength(1);
  await service.change({ port: 3000 }, true);
  ctx.hostHub.callHostOnlineRpc.mockResolvedValue({ state: 'connected', unavailablePorts: [5173] }); await service.reconcile();
  expect((await service.list()).shares[0].status).toBe('server-not-responding');
  ctx.hostHub.callHostOnlineRpc.mockRejectedValue(new Error('old')); await service.reconcile();
  expect((await service.list()).shares[0].status).toBe('update-required');
  ctx.hostHub.connectedHostIds = () => [local]; expect((await service.list()).shares[0].status).toBe('offline');
});
it('disabling remote access empties remote declarations and closes local previews', async () => {
  await service.change({ port: 5173 }); await service.change({ port: 3000, hostId: remote });
  enabled = false; await service.reconcile();
  expect(h.close).toHaveBeenCalled(); expect((await service.list()).shares.every(s => s.status === 'disabled')).toBe(true);
  expect(ctx.hostHub.callHostOnlineRpc).toHaveBeenLastCalledWith(expect.objectContaining({ command: expect.objectContaining({ targets: [] }) }));
  await expect(service.change({ port: 6000 })).rejects.toThrow('Turn on Remote access');
  await service.change({ port: 5173 }, true);
});
it('enforces the port cap and keeps an invalid saved registry from breaking server startup', async () => {
  for (let port = 20000; port < 20032; port++) await service.change({ port, hostId: remote });
  await expect(service.change({ port: 20033, hostId: remote })).rejects.toThrow('limit');
  service.dispose(); writeFileSync(join(dir, 'previews/leases.json'), '{broken');
  expect(() => { service = new PreviewService(ctx); }).not.toThrow();
  await expect(service.list()).rejects.toThrow('saved previews');
  await expect(service.change({ port: 5173 })).rejects.toThrow('saved previews');
});
it('old relays report update-required and account lookup failure does not stop active previews', async () => {
  h.state = 'update-required'; await service.change({ port: 5173 });
  expect((await service.list()).shares[0].status).toBe('update-required');
  service.dispose(); h.request.mockRejectedValue(new Error('offline')); service = new PreviewService(ctx);
  await service.reconcile(); expect(h.connect).toHaveBeenCalled();
});
