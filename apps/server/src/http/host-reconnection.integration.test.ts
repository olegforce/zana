import { afterEach, beforeEach, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createConversationThread, createEnvironment, getConversationThread, openHostSession, upsertHost } from '@zana-ai/zcc-db';
import { HOST_RPC_PROTOCOL_VERSION, type HostRuntimeSnapshot } from '@zana-ai/zcc-contracts/host-rpc';
import { startProductServer } from './product-server.js';
import { hashHostKey } from './host-hub.js';
import { createHostServerSocket } from '../../../host-daemon/src/server-socket.js';
import { healDisconnectedConversationThreadsForHost } from '../services/threads/conversation-host-recovery.js';

const key = 'fixture-key-with-enough-characters';
let dir: string, server: Awaited<ReturnType<typeof startProductServer>>;
let hostId: string, instanceId: string, environmentId: string;
let connections: ReturnType<typeof createHostServerSocket>[];
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'zcc-reconnect-'));
  server = await startProductServer({ dataDir: dir, origins: { serverPort: 0, devAppPort: 5173 } });
  const host = upsertHost(server.ctx.db, { name: 'fixture', hostKeyHash: hashHostKey(key), isPrimary: false });
  hostId = host.id; instanceId = randomUUID(); connections = [];
  openHostSession(server.ctx.db, { hostId, instanceId, hostName: host.name });
  environmentId = createEnvironment(server.ctx.db, { projectId: 'fixture', hostId, path: dir }).id;
});
afterEach(async () => { connections.forEach(c => c.close()); await server.close(); rmSync(dir, { recursive: true, force: true }); });
function connect(overrides: Partial<Parameters<typeof createHostServerSocket>[0]> = {}) {
  const c = createHostServerSocket({ serverUrl: server.url, hostId, hostKey: key, instanceId,
    onHello: async () => {}, onMessage: () => {}, onConnectionChange: () => {}, ...overrides });
  void c.ready.catch(() => {}); connections.push(c); return c;
}
function thread(status: 'active' | 'stopping' | 'error' | 'idle') {
  return createConversationThread(server.ctx.db, { projectId: 'fixture', hostId, environmentId, providerId: 'fake', status });
}

it('delivers pending Stop only after reconciliation and readiness, including beyond disconnect grace', async () => {
  const stopping = thread('stopping');
  healDisconnectedConversationThreadsForHost(server.ctx.db, server.ctx.hub, hostId);
  let finish!: () => void;
  const received: string[] = [];
  const c = connect({ onHello: () => new Promise<void>(resolve => { finish = resolve; }),
    onMessage: (raw, reply) => {
      const message = raw as any; received.push(message.command.type);
      reply(JSON.stringify({ type: 'host-rpc.response', protocolVersion: HOST_RPC_PROTOCOL_VERSION,
        requestId: message.requestId, commandType: 'thread.stop', ok: true, result: { threadId: stopping.id, stopped: true } }));
    } });
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  expect(server.ctx.hostHub.connectedHostIds()).not.toContain(hostId);
  expect(received).toEqual([]);
  finish(); await c.ready;
  await vi.waitFor(() => expect(getConversationThread(server.ctx.db, stopping.id)?.status).toBe('idle'));
  expect(received).toEqual(['thread.stop']);
});

it('a superseded daemon releases ownership instead of reclaiming the host', async () => {
  const hellos = [0, 0], terminated = vi.fn();
  const first = connect({ onHello: async () => { hellos[0]++; }, onTerminated: terminated });
  await first.ready;
  const replacementId = randomUUID();
  await connect({ instanceId: replacementId, onHello: async () => { hellos[1]++; } }).ready;
  await vi.waitFor(() => expect(terminated).toHaveBeenCalledOnce());
  await new Promise(resolve => setTimeout(resolve, 2300));
  expect(hellos).toEqual([1, 1]);
  expect(server.ctx.hostHub.getSession(hostId)?.instanceId).toBe(replacementId);
});

it('reconciles running, completed, failed and missing work from the same lifetime after grace expires', async () => {
  const first = connect(); await first.ready;
  const running = thread('active'), completed = thread('active'), failed = thread('active'), missing = thread('active');
  first.close(); await vi.waitFor(() => expect(server.ctx.hostHub.connectedHostIds()).not.toContain(hostId));
  healDisconnectedConversationThreadsForHost(server.ctx.db, server.ctx.hub, hostId);
  expect(getConversationThread(server.ctx.db, running.id)?.status).toBe('error');
  const runtime: HostRuntimeSnapshot = { loadedEnvironments: [environmentId], threads: [
    { threadId: running.id, status: 'active' }, { threadId: completed.id, status: 'idle' }, { threadId: failed.id, status: 'error' }
  ] };
  await connect({ getRuntimeSnapshot: () => runtime }).ready;
  expect([running, completed, failed, missing].map(t => getConversationThread(server.ctx.db, t.id)?.status)).toEqual(['active', 'idle', 'error', 'error']);
});

it('does not restore old work from a different process or mutate another host', async () => {
  const running = thread('active');
  const otherHost = upsertHost(server.ctx.db, { name: 'other', hostKeyHash: hashHostKey('other'), isPrimary: false });
  const foreign = createConversationThread(server.ctx.db, { projectId: 'fixture', hostId: otherHost.id, providerId: 'fake', status: 'error' });
  await connect({ instanceId: randomUUID(), getRuntimeSnapshot: () => ({ loadedEnvironments: [environmentId], threads: [
    { threadId: running.id, status: 'active' }, { threadId: foreign.id, status: 'active' }
  ] }) }).ready;
  expect(getConversationThread(server.ctx.db, running.id)?.status).toBe('error');
  expect(getConversationThread(server.ctx.db, foreign.id)?.status).toBe('error');
});

it.each(['malformed', 'wrong-lifetime'] as const)('rejects %s readiness without publishing the machine', async kind => {
  const url = new URL('internal/hosts/ws', server.url); url.protocol = 'ws:';
  const socket = new WebSocket(url, { headers: { authorization: `Bearer ${key}`, 'x-zcc-host-id': hostId } });
  try {
    await once(socket, 'open');
    const hello = once(socket, 'message');
    socket.send(JSON.stringify({ type: 'host.hello', protocolVersion: HOST_RPC_PROTOCOL_VERSION, hostId, instanceId }));
    await hello;
    const closed = once(socket, 'close');
    socket.send(kind === 'malformed' ? 'invalid JSON' : JSON.stringify({ type: 'host.ready', protocolVersion: HOST_RPC_PROTOCOL_VERSION,
      hostId, instanceId: randomUUID(), runtime: { threads: [], loadedEnvironments: [] } }));
    expect((await closed)[0]).toBe(4002);
    expect(server.ctx.hostHub.connectedHostIds()).not.toContain(hostId);
  } finally { socket.terminate(); }
});
