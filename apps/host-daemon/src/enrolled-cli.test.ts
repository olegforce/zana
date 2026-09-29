import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createEnrolledCli } from './enrolled-cli.js';
import type { PtyManagerHostServices } from './pty.js';
import type { CliTerminalStartCommand } from '@zana-ai/zcc-contracts/cli-terminal';
import type { AppConfig } from '@zana-ai/zcc-domain/product';

vi.mock('./pty.js', () => ({ PtyManager: class extends EventEmitter {} }));
vi.mock('./capacity.js', () => ({ resolveMaxLiveSessions: () => 2 }));
const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.restoreAllMocks(); });
function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'zcc-enrolled-cli-'))), root = join(home, 'project'); mkdirSync(root);
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const command: CliTerminalStartCommand = { type: 'terminal.start_cli', root, profile: 'claude', config: { autoModeEnabled: false }, cols: 90, rows: 30,
    grant: { projectId: 'project', sessionId: randomUUID(), credential: 'b'.repeat(64) } };
  const engines: Array<ReturnType<typeof engine>> = [], services: PtyManagerHostServices[] = [];
  function engine() {
    return Object.assign(new EventEmitter(), {
      create: vi.fn(input => ({ id: input.preallocatedSessionId, pid: 77 })),
      setProjectRoots: vi.fn(), setRulesResolver: vi.fn(), setMcpBaseUrl: vi.fn(),
      write: vi.fn(), resize: vi.fn(), close: vi.fn(), killAll: vi.fn()
    });
  }
  const proxy = { baseUrl: 'http://127.0.0.1:1234/session-capability', close: vi.fn(async () => {}) };
  const startProxy = vi.fn(async () => proxy), emit = vi.fn();
  const createEngine = vi.fn((service: PtyManagerHostServices) => { services.push(service); const manager = engine(); engines.push(manager); return manager as never; });
  const runtime = createEnrolledCli({ serverUrl: 'https://example.test/t/connect', hostId: randomUUID(), hostKey: 'host-secret',
    loadConfig: () => ({ claudeBinary: '/host/claude', shell: '/bin/sh' }) as AppConfig,
    emit, createEngine, startProxy });
  cleanup.push(() => runtime.dispose());
  return { home, root, command, runtime, engines, services, proxy, startProxy, createEngine, emit };
}
it('binds one session capability, own binaries, cwd, rules, input and resize; cleans up on exit', async () => {
  const f = fixture(); f.command.rules = 'shared rules';
  expect(await f.runtime.startTerminal(f.command)).toEqual({ pid: 77 });
  const e = f.engines[0], id = f.command.grant.sessionId;
  expect(e.create).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'project', preallocatedSessionId: id, cwd: f.root, config: expect.objectContaining({ claudeBinary: '/host/claude', autoModeEnabled: false }) }));
  expect(e.setProjectRoots.mock.calls[0][0]()).toEqual([f.root]);
  expect(e.setRulesResolver.mock.calls[0][0]()).toBe('shared rules');
  expect(e.setMcpBaseUrl).toHaveBeenCalledWith(f.proxy.baseUrl);
  expect(f.services[0].sessionCredential!(id)).toBe(f.command.grant.credential);
  expect(() => f.services[0].sessionCredential!('other')).toThrow('mismatch');
  f.services[0].prepareNativePty!();
  expect(f.services[0].resolveHarnessAuth).toBeUndefined();
  await f.runtime.writeTerminal({ sessionId: id, data: 'input' }); await f.runtime.resizeTerminal({ sessionId: id, cols: 101, rows: 33 });
  expect(e.write).toHaveBeenCalledWith(id, 'input'); expect(e.resize).toHaveBeenCalledWith(id, 101, 33);
  e.emit('data', 'other', 'ignored'); e.emit('exit', 'other', 1); e.emit('data', id, 'output'); e.emit('exit', id, 7);
  expect(f.emit.mock.calls.map(call => call[0])).toEqual([{ terminalId: id, kind: 'terminal.output', payload: { data: 'output' } }, { terminalId: id, kind: 'terminal.exited', payload: { exitCode: 7 } }]);
  expect(f.runtime.has(id)).toBe(false); expect(e.listenerCount('data')).toBe(0); expect(e.listenerCount('exit')).toBe(0);
  expect(f.proxy.close).toHaveBeenCalledOnce();
  await expect(f.runtime.startTerminal(f.command)).rejects.toThrow('already been used');
  await expect(f.runtime.writeTerminal({ sessionId: id, data: 'late' })).rejects.toThrow('unavailable');
  await expect(f.runtime.resizeTerminal({ sessionId: id, cols: 80, rows: 24 })).rejects.toThrow('unavailable');
  await f.runtime.stopTerminal({ sessionId: id });
});
it('reserves capacity during async startup and cancels without a late spawn', async () => {
  const f = fixture(); let resolve!: (value: typeof f.proxy) => void;
  f.startProxy.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  const pending = f.runtime.startTerminal(f.command); const rejected = expect(pending).rejects.toThrow('cancelled');
  await expect(f.runtime.startTerminal(f.command)).rejects.toThrow('already been used');
  await expect(f.runtime.writeTerminal({ sessionId: f.command.grant.sessionId, data: '' })).rejects.toThrow('unavailable');
  await f.runtime.startTerminal({ ...f.command, grant: { ...f.command.grant, sessionId: randomUUID() } });
  await expect(f.runtime.startTerminal({ ...f.command, grant: { ...f.command.grant, sessionId: randomUUID() } })).rejects.toThrow('capacity');
  await f.runtime.stopTerminal({ sessionId: f.command.grant.sessionId });
  await expect(f.runtime.startTerminal({ ...f.command, grant: { ...f.command.grant, sessionId: randomUUID() } })).rejects.toThrow('capacity');
  resolve(f.proxy); await rejected;
  expect(f.createEngine).toHaveBeenCalledOnce();
  await f.runtime.dispose(); expect(f.engines[0].killAll).toHaveBeenCalledOnce();
  await expect(f.runtime.startTerminal(f.command)).rejects.toThrow('closed');
});
it('cleans pending proxies after disposal and failed setup/spawn without reusing the identity', async () => {
  const f = fixture(); f.startProxy.mockRejectedValueOnce(new Error('bind failed'));
  await expect(f.runtime.startTerminal(f.command)).rejects.toThrow('bind failed');
  expect(f.runtime.has(f.command.grant.sessionId)).toBe(false);
  f.createEngine.mockImplementationOnce(service => { f.services.push(service); throw new Error('engine failed'); });
  await expect(f.runtime.startTerminal({ ...f.command, grant: { ...f.command.grant, sessionId: randomUUID() } })).rejects.toThrow('engine failed');
  let resolve!: (value: typeof f.proxy) => void;
  f.startProxy.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  const pending = f.runtime.startTerminal({ ...f.command, grant: { ...f.command.grant, sessionId: randomUUID() } });
  const rejected = expect(pending).rejects.toThrow('cancelled'); await f.runtime.dispose(); resolve(f.proxy); await rejected;
  expect(f.proxy.close).toHaveBeenCalledTimes(2);
});
it('rejects malformed paths and fences directory substitution while the proxy starts', async () => {
  const f = fixture(), outside = join(f.home, 'outside'), file = join(f.root, 'file'), link = join(f.home, 'root-link');
  mkdirSync(outside); writeFileSync(file, 'x'); symlinkSync(f.root, link); symlinkSync(outside, join(f.root, 'escape'));
  for (const patch of [{ root: 'relative' }, { cwd: 'relative' }, { root: link }, { root: file }, { cwd: file }, { cwd: outside }, { cwd: join(f.root, 'escape') }, { root: '/missing' }, { profile: 'shell' }]) {
    await expect(f.runtime.startTerminal({ ...f.command, ...patch } as never)).rejects.toThrow();
  }
  expect(f.startProxy).not.toHaveBeenCalled();
  f.startProxy.mockImplementationOnce(async () => { renameSync(f.root, `${f.root}-old`); mkdirSync(f.root); return f.proxy; });
  await expect(f.runtime.startTerminal(f.command)).rejects.toThrow('changed');
  expect(f.engines[0].create).not.toHaveBeenCalled(); expect(f.engines[0].killAll).toHaveBeenCalledOnce();
});
it('releases subscriptions and proxy on explicit stop, including synchronous exit', async () => {
  const f = fixture(); await f.runtime.startTerminal(f.command); const e = f.engines[0], id = f.command.grant.sessionId;
  expect(e.setRulesResolver.mock.calls[0][0]()).toBe(null);
  await f.runtime.stopTerminal({ sessionId: id }); expect(e.close).toHaveBeenCalledWith(id);
  e.emit('data', id, 'late'); e.emit('exit', id, 0); expect(f.emit).not.toHaveBeenCalled();
  expect(e.listenerCount('exit')).toBe(0); expect(f.proxy.close).toHaveBeenCalledOnce();
});

it('does not spawn twice after a startup exception and bounds lifetime replay protection', async () => {
  const f = fixture();
  // Each rejected bind still consumes an identity: a caller cannot reuse one
  // whose earlier outcome became ambiguous to its owner.
  f.startProxy.mockRejectedValue(new Error('bind failed'));
  for (let n = 0; n < 4096; n++) {
    await expect(f.runtime.startTerminal({ ...f.command, grant: { ...f.command.grant, sessionId: randomUUID() } })).rejects.toThrow('bind failed');
  }
  await expect(f.runtime.startTerminal(f.command)).rejects.toThrow('identity capacity');
  expect(f.createEngine).not.toHaveBeenCalled();
});
