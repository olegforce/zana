import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createConversationThread, createEnvironment, createPendingInteraction, destroyHost, getHost, openHostSession, closeHostSession, upsertHost } from '@zana-ai/zcc-db';
import { HOST_RPC_PROTOCOL_VERSION } from '@zana-ai/zcc-contracts/host-rpc';
import type { HostPerformanceSummary } from '@zana-ai/zcc-server-contract';
import { startProductServer, type ProductServer } from './product-server.js';
import { hashHostKey } from './host-hub.js';
import { PERFORMANCE_WORKLOAD_CAP, PERFORMANCE_THREAD_LIST_CAP, PERFORMANCE_WORKLOAD_SQL } from './host-performance.js';

let server: ProductServer;
let dir: string;
const sockets: WebSocket[] = [];
const key = 'test-performance-host-key-with-enough-bytes';
const terminal = (id: string, hostId: string, status: 'running' | 'exited') => ({
  id, hostId, status, projectId: 'project', title: 'Shell', profile: 'shell', cwd: '/tmp', createdAt: Date.now()
});
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'zcc-performance-'));
  server = await startProductServer({ dataDir: dir, origins: { serverPort: 0, devAppPort: 5173 } });
});
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});
const host = (name: string) => upsertHost(server.ctx.db, { name, hostKeyHash: hashHostKey(key), isPrimary: false });
const read = async (id: string): Promise<HostPerformanceSummary> => (await fetch(`${server.url}api/v1/hosts/${id}/performance`)).json();
async function connect(id: string) {
  const url = new URL('internal/hosts/ws', server.url); url.protocol = 'ws:';
  const socket = new WebSocket(url, { headers: { authorization: `Bearer ${key}`, 'x-zcc-host-id': id } });
  sockets.push(socket);
  await once(socket, 'open');
  const hello = once(socket, 'message');
  socket.send(JSON.stringify({ type: 'host.hello', protocolVersion: HOST_RPC_PROTOCOL_VERSION, hostId: id, instanceId: randomUUID() }));
  await hello;
  return socket;
}

describe('host performance HTTP', () => {
  it('requires a registered live host record and enforces the existing origin boundary', async () => {
    expect((await fetch(`${server.url}api/v1/hosts/missing/performance`)).status).toBe(404);
    const h = host('removed'); destroyHost(server.ctx.db, h.id);
    expect((await fetch(`${server.url}api/v1/hosts/${h.id}/performance`)).status).toBe(404);
    const active = host('active');
    expect((await fetch(`${server.url}api/v1/hosts/${active.id}/performance`, { headers: { origin: 'https://untrusted.example' } })).status).toBe(403);
  });
  it('counts only work belonging to the selected host, including hidden active threads', async () => {
    const a = host('a'), b = host('b');
    const environment = createEnvironment(server.ctx.db, { projectId: 'project', hostId: a.id, path: '/tmp/project' });
    for (const [hostId, status, visibility] of [[a.id, 'active', 'hidden'], [a.id, 'starting', 'visible'], [a.id, 'idle', 'visible'], [a.id, 'error', 'visible'], [b.id, 'active', 'visible']] as const) {
      createConversationThread(server.ctx.db, { projectId: 'project', hostId, environmentId: environment.id, providerId: 'fake', status, visibility });
    }
    // This summary only consumes host and lifecycle facts from the terminal map.
    server.ctx.terminalSessions.set('t1', terminal('t1', a.id, 'running'));
    server.ctx.terminalSessions.set('t2', terminal('t2', a.id, 'exited'));
    server.ctx.terminalSessions.set('t3', terminal('t3', b.id, 'running'));
    expect(await read(a.id)).toMatchObject({ hostId: a.id, connected: false, connectedAt: null, lastHeartbeatAt: null,
      workload: { activeThreads: 2, threadStates: { starting: 1, active: 1, waiting: 0, stopping: 0 }, terminals: 1, truncated: false }, recentConnections: [] });
  });
  it('counts disjoint states using unresolved interactions and returns only bounded display metadata', async () => {
    const a = host('a');
    const environment = createEnvironment(server.ctx.db, { projectId: 'project', hostId: a.id, path: '/tmp/project' });
    const add = (id: string, status: 'starting' | 'active' | 'stopping' | 'idle', interactionStatus?: string) => {
      createConversationThread(server.ctx.db, { id, projectId: 'project', hostId: a.id, environmentId: environment.id, providerId: 'fake', status, visibility: 'hidden', title: 'T'.repeat(300) });
      if (interactionStatus) {
        const interaction = createPendingInteraction(server.ctx.db, { originKind: 'plugin', threadId: id, pluginId: 'test', rendererId: 'prompt', payload: 'private-prompt' });
        server.ctx.db.sqlite.prepare('UPDATE pending_interactions SET status = ? WHERE id = ?').run(interactionStatus, interaction.id);
      }
    };
    add('starting', 'starting', 'pending'); add('active', 'active', 'resolved');
    add('waiting', 'active', 'pending'); add('resolving', 'active', 'resolving');
    add('stopping', 'stopping', 'pending'); add('idle', 'idle', 'pending');
    createPendingInteraction(server.ctx.db, { originKind: 'plugin', threadId: 'waiting', pluginId: 'test', rendererId: 'prompt', payload: 'another-private-prompt' });
    const summary = await read(a.id);
    expect(summary.workload).toEqual({ activeThreads: 5, threadStates: { starting: 1, active: 1, waiting: 2, stopping: 1 }, terminals: 0, truncated: false });
    expect(summary.threads.slice(0, 2).map(t => t.state)).toEqual(['waiting', 'waiting']);
    expect(summary.threads.find(t => t.id === 'waiting')).toEqual({ id: 'waiting', projectId: 'project', providerId: 'fake', title: 'T'.repeat(256), visibility: 'hidden', state: 'waiting' });
    expect(JSON.stringify(summary)).not.toContain('private-prompt');
    const plan = JSON.stringify(server.ctx.db.sqlite.prepare(`EXPLAIN QUERY PLAN ${PERFORMANCE_WORKLOAD_SQL}`).all(a.id, 1001));
    expect(plan).toContain('threads_live_host_idx');
    expect(plan).toContain('pending_interactions_thread_status_created_idx');
    expect(plan).not.toContain('TEMP B-TREE');
  });
  it('bounds workload scans and connection history', async () => {
    const a = host('a');
    const environment = createEnvironment(server.ctx.db, { projectId: 'project', hostId: a.id, path: '/tmp/project' });
    server.ctx.db.transaction(() => {
      for (let i = 0; i <= PERFORMANCE_WORKLOAD_CAP; i++) createConversationThread(server.ctx.db, {
        projectId: 'project', hostId: a.id, environmentId: environment.id, providerId: 'fake', status: 'active'
      });
      for (let i = 0; i < 10; i++) { openHostSession(server.ctx.db, { hostId: a.id, hostName: 'a', instanceId: randomUUID() }); closeHostSession(server.ctx.db, a.id, 'socket-closed'); }
    });
    server.ctx.terminalSessions.set('t', terminal('t', a.id, 'running'));
    const summary = await read(a.id);
    expect(summary.workload).toEqual({ activeThreads: PERFORMANCE_WORKLOAD_CAP, threadStates: { starting: 0, active: PERFORMANCE_WORKLOAD_CAP, waiting: 0, stopping: 0 }, terminals: 1, truncated: true });
    expect(summary.threads).toHaveLength(PERFORMANCE_THREAD_LIST_CAP);
    expect(summary.threads.every(thread => thread.title === null)).toBe(true);
    expect(summary.recentConnections).toHaveLength(6);
    expect(summary.recentConnections.every(row => row.reason === 'socket-closed')).toBe(true);
  });
  it('records received heartbeats in memory, resets on reconnect and keeps disconnection history', async () => {
    const a = host('a'); const socket = await connect(a.id);
    const connected = await read(a.id);
    expect(connected).toMatchObject({ connected: true, lastHeartbeatAt: null });
    expect(connected.connectedAt).toBeGreaterThan(0);
    const lastSeen = getHost(server.ctx.db, a.id)!.lastSeenAt;
    socket.send(JSON.stringify({ type: 'heartbeat' }));
    await expect.poll(async () => (await read(a.id)).lastHeartbeatAt).not.toBeNull();
    expect(getHost(server.ctx.db, a.id)!.lastSeenAt).toBe(lastSeen);
    socket.close(); await once(socket, 'close');
    await expect.poll(async () => (await read(a.id)).connected).toBe(false);
    expect((await read(a.id)).recentConnections[0]).toMatchObject({ reason: 'socket-closed' });
    await connect(a.id);
    expect(await read(a.id)).toMatchObject({ connected: true, lastHeartbeatAt: null });
  });
});
