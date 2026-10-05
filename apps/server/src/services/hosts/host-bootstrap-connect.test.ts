import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { openDatabase, upsertHost, updateHostSshIdentity, getHost } from '@zana-ai/zcc-db';
import { bootstrapHostForProject, repairHost } from './host-bootstrap.js';
import { issueConnectHostCode } from './connect-enrollment.js';
import type { ProductHttpContext } from '../../http/product-context.js';

vi.mock('./connect-enrollment.js', async importOriginal => ({
  ...await importOriginal<typeof import('./connect-enrollment.js')>(),
  usesConnect: () => true,
  issueConnectHostCode: vi.fn()
}));
const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); vi.clearAllMocks(); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'zcc-connect-repair-'));
  const db = openDatabase(join(dir, 'state.sqlite'));
  cleanup.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const primary = upsertHost(db, { name: 'Primary', hostKeyHash: 'a'.repeat(64), isPrimary: true });
  const remote = upsertHost(db, { name: 'Remote', hostKeyHash: 'b'.repeat(64), isPrimary: false });
  updateHostSshIdentity(db, remote.id, { host: 'devbox', user: 'me', proxyJump: 'bastion' });
  const issued = { hostId: remote.id, accountUrl: 'https://account.example', serverUrl: 'https://machine.example', serverId: randomUUID(), code: 'ABCD-ABCD-ABCD-ABCD-ABCD-ABCD-ABCD-ABCD', enrollmentId: 'a'.repeat(64), expiresAt: Date.now() + 60_000 };
  vi.mocked(issueConnectHostCode).mockResolvedValue(issued);
  const project = { id: 'project', name: 'Remote project', path: '/placeholder', remote: { host: 'devbox', user: 'me', proxyJump: 'bastion', remotePath: '/srv/project' } };
  const rpc = vi.fn(async () => ({ ok: true, log: 'Machine connected' }));
  const wait = vi.fn(async () => {});
  const bind = vi.fn(async () => {});
  const ctx = {
    db, dataDir: dir,
    hostHub: { ensureHostSessionReady: vi.fn(), connectedHostIds: () => [], callHostOnlineRpc: rpc, waitUntilConnected: wait },
    projects: { list: () => [project], bindToHost: bind },
    hub: { emit: vi.fn() },
    joinCodes: { mint: vi.fn(() => { throw new Error('Legacy enrollment must not run'); }) }
  } as unknown as ProductHttpContext;
  return { ctx, primary, remote, issued, rpc, wait, bind };
}

it('repairs through Connect on the primary host while preserving the remote identity and SSH scope', async () => {
  const f = fixture();
  const events = await repairHost(f.ctx, f.remote.id);
  expect(events.at(-1)).toEqual({ type: 'done', hostId: f.remote.id });
  expect(issueConnectHostCode).toHaveBeenCalledWith(f.ctx, { name: 'devbox', hostId: f.remote.id });
  expect(f.rpc).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ hostId: f.primary.id, command: {
    type: 'peer_daemon.install', remote: { host: 'devbox', user: 'me', proxyJump: 'bastion' },
    connect: { accountUrl: f.issued.accountUrl, serverId: f.issued.serverId, code: f.issued.code }
  } }));
  expect(f.wait).toHaveBeenCalledWith(f.remote.id, expect.any(Number));
  expect(getHost(f.ctx.db, f.remote.id)?.sshHost).toBe('devbox');
});

it('binds a remote project after Connect repairs its existing host', async () => {
  const f = fixture();
  expect((await bootstrapHostForProject(f.ctx, 'project')).at(-1)).toEqual({ type: 'done', hostId: f.remote.id });
  expect(f.bind).toHaveBeenCalledWith('project', { hostId: f.remote.id, path: '/srv/project' });
});

it('uses Connect for a first installation and binds only after the host connects', async () => {
  const f = fixture();
  updateHostSshIdentity(f.ctx.db, f.remote.id, { host: 'another' });
  expect((await bootstrapHostForProject(f.ctx, 'project')).at(-1)).toEqual({ type: 'done', hostId: f.remote.id });
  expect(issueConnectHostCode).toHaveBeenCalledWith(f.ctx, { name: 'devbox' });
  expect(f.bind).toHaveBeenCalledOnce();
});

it('does not re-enroll an already connected machine', async () => {
  const f = fixture();
  f.ctx.hostHub.connectedHostIds = () => [f.remote.id];
  await bootstrapHostForProject(f.ctx, 'project');
  expect(issueConnectHostCode).not.toHaveBeenCalled();
  expect(f.rpc).not.toHaveBeenCalled();
});

it('surfaces install failure with the correct Connect command without binding the project', async () => {
  const f = fixture();
  f.rpc.mockRejectedValue(new Error('TLS connection failed'));
  const events = await bootstrapHostForProject(f.ctx, 'project');
  expect(events.at(-1)).toMatchObject({ type: 'error', code: 'install_failed', message: 'TLS connection failed', pairingCommand: expect.stringContaining('/api/connect/host-installer') });
  expect(f.bind).not.toHaveBeenCalled();
});

it('does not report a successful install as connected until the host becomes ready', async () => {
  const f = fixture();
  f.wait.mockRejectedValue(new Error('unexpected connection failure'));
  const events = await repairHost(f.ctx, f.remote.id);
  expect(events.at(-1)).toMatchObject({ type: 'error', message: 'unexpected connection failure' });
  expect(events.some(event => event.type === 'done')).toBe(false);
});
