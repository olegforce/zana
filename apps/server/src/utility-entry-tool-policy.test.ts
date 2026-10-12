import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { SERVER_RUNTIME_PROTOCOL_VERSION } from '@zana-ai/zcc-contracts/runtime';

// The real runtime boundary stays in place: requests must pass the v14 schema,
// and a handler throw becomes an `error` reply carrying the request id.
const h = vi.hoisted(() => ({
  context: null as any,
  decide: vi.fn(),
  close: vi.fn(async () => undefined)
}));
vi.mock('./services/threads/thread-reads.js', async original => ({
  ...await original<typeof import('./services/threads/thread-reads.js')>(), prepareThreadReads: async () => undefined
}));
vi.mock('./http/product-context.js', async original => ({
  ...await original<typeof import('./http/product-context.js')>(), createProductHttpContext: () => h.context
}));
vi.mock('./http/product-plugins.js', async original => ({
  ...await original<typeof import('./http/product-plugins.js')>(),
  // Mirrors the real wrapper: stop() clears ctx.plugins.
  createAttachedProductPluginService: (ctx: any) => {
    const service = {
      decideToolPolicy: h.decide,
      refreshSafeMode: async () => undefined,
      stop() { if (ctx.plugins === service) ctx.plugins = undefined; }
    };
    ctx.plugins = service;
    return service;
  },
  startAttachedProductPluginService: async () => undefined
}));
vi.mock('./static-host.js', () => ({ startStaticHost: async () => ({ url: 'http://127.0.0.1:0/', close: h.close }) }));
vi.mock('./runtime-database.js', () => ({ createRuntimeDatabase: () => ({ close() {} }) }));
vi.mock('./terminal-execution-service.js', () => ({ createTerminalExecutionService: () => ({ binding: { hostId: 'test-host' } }) }));
vi.mock('./terminal-session-service.js', () => ({ TerminalSessionService: class {
  refreshHostConnection() { return Promise.resolve(); }
} }));
vi.mock('@zana-ai/zcc-process-utils', async original => ({
  ...await original<typeof import('@zana-ai/zcc-process-utils')>(), installRuntimeLog() {}
}));

const call = {
  invocationId: 'b'.repeat(64),
  threadId: 'session-1',
  projectId: 'project-1',
  profile: 'claude-resume',
  toolName: 'Bash',
  input: { command: 'deploy', token: 'secret-value' }
};

it('answers main-owned tool policy calls from the attached plugin service, and denies outside its lifetime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'utility-tool-policy-'));
  const parent = Object.assign(new EventEmitter(), { postMessage: vi.fn() });
  const descriptor = Object.getOwnPropertyDescriptor(process, 'parentPort');
  Object.defineProperty(process, 'parentPort', { configurable: true, value: parent });
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  h.context = { db: {}, hub: { emit() {}, subscribe: () => () => undefined }, config: { getConfig: () => ({}) } };
  const decide = async (request: Record<string, unknown> = call) => {
    const id = randomUUID();
    parent.emit('message', { data: {
      type: 'request', protocolVersion: SERVER_RUNTIME_PROTOCOL_VERSION, id,
      deadlineAt: new Date(Date.now() + 20_000).toISOString(), operation: 'plugins-tool-policy', request
    } });
    await vi.waitFor(() => expect(parent.postMessage).toHaveBeenCalledWith(expect.objectContaining({ id })));
    return parent.postMessage.mock.calls.map(([message]) => message).find((message) => message.id === id);
  };
  let stopped = false;
  try {
    await import('./utility-entry.js');
    await expect(decide()).resolves.toEqual({
      type: 'result', protocolVersion: SERVER_RUNTIME_PROTOCOL_VERSION, id: expect.any(String),
      value: { action: 'deny', reason: 'plugin service is unavailable' }
    });

    parent.emit('message', { data: {
      type: 'start', protocolVersion: SERVER_RUNTIME_PROTOCOL_VERSION, rendererRoot: root, dataDir: root,
      hostUrl: 'http://127.0.0.1:1', hostToken: 't'.repeat(32), hostSigningKey: 's'.repeat(32),
      hostBinding: { hostId: randomUUID(), instanceId: randomUUID() }, version: '0.0.0-test'
    } });
    await vi.waitFor(() => expect(parent.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'ready' })));

    h.decide.mockResolvedValueOnce({ action: 'deny', reason: '   ' });
    await expect(decide()).resolves.toMatchObject({ type: 'result', value: { action: 'deny', reason: 'denied by plugin tool policy' } });
    expect(h.decide).toHaveBeenLastCalledWith({
      invocationId: call.invocationId, threadId: 'session-1', projectId: 'project-1',
      providerId: 'claude-code', toolName: 'Bash', input: { command: 'deploy', token: '[REDACTED]' }
    });
    h.decide.mockResolvedValueOnce({ action: 'allow' });
    await expect(decide()).resolves.toMatchObject({ type: 'result', value: { action: 'allow' } });

    h.decide.mockRejectedValueOnce(new Error('policy worker crashed'));
    await expect(decide()).resolves.toMatchObject({ type: 'error', message: 'policy worker crashed' });
    const calls = h.decide.mock.calls.length;
    await expect(decide({ ...call, invocationId: 'not-a-digest' })).resolves.toMatchObject({ type: 'error' });
    expect(h.decide).toHaveBeenCalledTimes(calls);

    parent.emit('message', { data: { type: 'stop', protocolVersion: SERVER_RUNTIME_PROTOCOL_VERSION } });
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    stopped = true;
    await expect(decide()).resolves.toMatchObject({ type: 'result', value: { action: 'deny', reason: 'plugin service is unavailable' } });
    expect(h.decide).toHaveBeenCalledTimes(calls);
  } finally {
    if (!stopped) {
      parent.emit('message', { data: { type: 'stop', protocolVersion: SERVER_RUNTIME_PROTOCOL_VERSION } });
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    }
    exit.mockRestore();
    if (descriptor) Object.defineProperty(process, 'parentPort', descriptor);
    else Reflect.deleteProperty(process, 'parentPort');
    await rm(root, { recursive: true, force: true });
  }
});
