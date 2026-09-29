import * as nativePty from 'node-pty';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnrolledPty, resolveEnrolledShell, type EnrolledPtyHandle } from './enrolled-pty.js';
import type { HostEventEnvelope } from '@zana-ai/zcc-contracts/host-rpc';
vi.mock('node-pty', () => ({ spawn: vi.fn() }));

function fakeHandle(): EnrolledPtyHandle & {
  writes: string[];
  resizes: Array<{ cols: number; rows: number }>;
  killed: boolean;
  signals: string[];
  data?: (chunk: string) => void;
  exit?: (event: { exitCode: number }) => void;
} {
  const handle = {
    pid: 7,
    writes: [] as string[],
    resizes: [] as Array<{ cols: number; rows: number }>,
    killed: false,
    signals: [] as string[],
    data: undefined as ((chunk: string) => void) | undefined,
    exit: undefined as ((event: { exitCode: number }) => void) | undefined,
    write(data: string) { handle.writes.push(data); },
    resize(cols: number, rows: number) { handle.resizes.push({ cols, rows }); },
    kill(signal?: string) {
      handle.killed = true;
      handle.signals.push(signal ?? 'default');
    },
    onData(listener: (data: string) => void) { handle.data = listener; },
    onExit(listener: (event: { exitCode: number }) => void) { handle.exit = listener; }
  };
  return handle;
}

describe('enrolled pty', () => {
  it('uses the host shell, then BB executable fallbacks for minimal Linux services', () => {
    expect(resolveEnrolledShell({ SHELL: '/custom/fish' }, () => true)).toBe('/custom/fish');
    expect(resolveEnrolledShell({ SHELL: '/missing' }, path => path === '/bin/bash')).toBe('/bin/bash');
    expect(resolveEnrolledShell({}, () => false)).toBe('/bin/sh');
    expect(resolveEnrolledShell({ SHELL: '/this-does-not-exist' })).toMatch(/^\/bin\/(zsh|bash|sh)$/);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('starts, writes, resizes, and emits output plus exit', async () => {
    const events: HostEventEnvelope[] = [];
    const handle = fakeHandle();
    const pty = createEnrolledPty({
      emit: (event) => events.push(event),
      spawn: () => handle
    });
    const started = await pty.startTerminal({
      sessionId: '11111111-1111-4111-8111-111111111111',
      cwd: '/tmp',
      cols: 80,
      rows: 24
    });
    expect(started.pid).toBe(7);
    handle.data?.('hello');
    await pty.writeTerminal({ sessionId: '11111111-1111-4111-8111-111111111111', data: 'ls\n' });
    await pty.resizeTerminal({ sessionId: '11111111-1111-4111-8111-111111111111', cols: 120, rows: 40 });
    handle.exit?.({ exitCode: 0 });
    expect(handle.writes).toEqual(['ls\n']);
    expect(handle.resizes).toEqual([{ cols: 120, rows: 40 }]);
    expect(events).toEqual([
      {
        terminalId: '11111111-1111-4111-8111-111111111111',
        kind: 'terminal.output',
        payload: { data: 'hello' }
      },
      {
        terminalId: '11111111-1111-4111-8111-111111111111',
        kind: 'terminal.exited',
        payload: { exitCode: 0 }
      }
    ]);
  });

  it('passes a login-shell -lc argv when a launch string is set', async () => {
    const spawned: Array<{ args: string[] }> = [];
    const handle = fakeHandle();
    const pty = createEnrolledPty({
      emit: () => {},
      spawn: (_file, args) => {
        spawned.push({ args });
        return handle;
      }
    });
    await pty.startTerminal({
      sessionId: '11111111-1111-4111-8111-111111111111',
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      command: '  npm run dev  '
    });
    expect(spawned).toEqual([{ args: ['-lc', 'npm run dev'] }]);
    await pty.startTerminal({
      sessionId: '11111111-1111-4111-8111-111111111112',
      cwd: '/tmp',
      cols: 80,
      rows: 24
    });
    expect(spawned[1]).toEqual({ args: ['-l'] });
  });

  it('stops the whole PTY process group before dropping the session', async () => {
    const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const handle = fakeHandle();
    const pty = createEnrolledPty({
      emit: () => {},
      spawn: () => handle
    });
    await pty.startTerminal({
      sessionId: '11111111-1111-4111-8111-111111111111',
      cwd: '/tmp',
      cols: 80,
      rows: 24
    });

    await pty.stopTerminal({ sessionId: '11111111-1111-4111-8111-111111111111' });

    expect(processKill).toHaveBeenCalledWith(-7, 'SIGTERM');
    expect(handle.signals).toEqual(['SIGTERM']);
  });
});

it('rejects duplicate live ids and fences callbacks from closed handles', async () => {
  vi.spyOn(process, 'kill').mockImplementation(() => true);
  try {
    const events: HostEventEnvelope[] = [], handles = [fakeHandle(), fakeHandle()];
    const spawn = vi.fn(() => handles[spawn.mock.calls.length - 1]!);
    const pty = createEnrolledPty({ emit: event => events.push(event), spawn });
    const input = { sessionId: 's', cwd: '/tmp', cols: 80, rows: 24 };
    await pty.startTerminal(input);
    await expect(pty.startTerminal(input)).rejects.toThrow('already');
    expect(spawn).toHaveBeenCalledOnce();
    await pty.stopTerminal(input);
    await pty.stopTerminal(input);
    await pty.startTerminal(input);
    handles[0]!.data?.('stale'); handles[0]!.exit?.({ exitCode: 1 });
    await pty.writeTerminal({ sessionId: 's', data: 'new' });
    expect(handles[1]!.writes).toEqual(['new']); expect(events).toEqual([]);
    pty.dispose();
    await expect(pty.writeTerminal({ sessionId: 's', data: 'late' })).rejects.toThrow('unknown');
  } finally { vi.restoreAllMocks(); }
});
it('bounds running processes and releases slots on natural exit', async () => {
  vi.spyOn(process, 'kill').mockImplementation(() => true);
  try {
    const handles: ReturnType<typeof fakeHandle>[] = [];
    const pty = createEnrolledPty({ emit: () => {}, spawn: () => { const handle = fakeHandle(); handles.push(handle); return handle; } });
    for (let i = 0; i < 128; i++) await pty.startTerminal({ sessionId: String(i), cwd: '/tmp', cols: 80, rows: 24 });
    await expect(pty.startTerminal({ sessionId: 'overflow', cwd: '/tmp', cols: 80, rows: 24 })).rejects.toThrow('capacity');
    handles[0]!.exit?.({ exitCode: 0 });
    await pty.startTerminal({ sessionId: 'after-exit', cwd: '/tmp', cols: 80, rows: 24 });
    pty.dispose();
    await expect(pty.resizeTerminal({ sessionId: 'after-exit', cols: 10, rows: 10 })).rejects.toThrow('unknown');
  } finally { vi.restoreAllMocks(); }
});

it('adapts the native PTY callbacks and methods without changing their payloads', async () => {
  vi.spyOn(process, 'kill').mockImplementation(() => true);
  try {
    const handle = fakeHandle(), emit = vi.fn();
    vi.mocked(nativePty.spawn).mockReturnValue(handle as never);
    const pty = createEnrolledPty({ emit, shell: '/bin/sh' });
    await pty.startTerminal({ sessionId: 'native', cwd: '/tmp', cols: 80, rows: 24 });
    await pty.writeTerminal({ sessionId: 'native', data: 'input' });
    await pty.resizeTerminal({ sessionId: 'native', cols: 100, rows: 30 });
    handle.data?.('output'); handle.exit?.({ exitCode: 3 });
    expect(emit).toHaveBeenLastCalledWith({ terminalId: 'native', kind: 'terminal.exited', payload: { exitCode: 3 } });
    expect(handle.writes).toEqual(['input']); expect(handle.resizes).toEqual([{ cols: 100, rows: 30 }]);
    await pty.startTerminal({ sessionId: 'second', cwd: '/tmp', cols: 80, rows: 24 });
    pty.dispose(); expect(handle.killed).toBe(true);
  } finally { vi.restoreAllMocks(); }
});
