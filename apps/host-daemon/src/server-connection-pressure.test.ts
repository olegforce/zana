import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  callbacks: null as null | Parameters<typeof import('./event-sink.js').createEventSink>[0],
  paused: vi.fn(), overflow: vi.fn(), ptyDispose: vi.fn(), adapterDispose: vi.fn()
}));
vi.mock('./event-sink.js', () => ({ createEventSink: (options: NonNullable<typeof state.callbacks>) => {
  state.callbacks = options;
  // The sink can signal before a terminal producer has been constructed.
  options.onPressure?.(true); options.onTerminalOverflow?.('early');
  return { emit: vi.fn(), flush: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
} }));
vi.mock('./runtime-manager.js', () => ({ createRuntimeManager: () => ({ dispose: state.adapterDispose }) }));
vi.mock('./enrolled-pty.js', () => ({ createEnrolledPty: () => ({ setOutputPaused: state.paused, stopOverflowedTerminal: state.overflow, dispose: state.ptyDispose }) }));
vi.mock('./plugin-host-manager.js', () => ({ PluginHostManager: class { async shutdown() {} async reconcileGenerations() {} } }));
vi.mock('./workspace-fs-watch.js', () => ({ hostFsWatcher: () => ({}) }));
vi.mock('./server-socket.js', () => ({ createHostServerSocket: () => ({ connected: false, ready: Promise.resolve(), close: vi.fn(), reconnect: vi.fn(), send: vi.fn() }) }));
vi.mock('./desktop-browser-broker.js', () => ({ startDesktopBrowserBroker: async () => ({ close: async () => {}, setConnected: vi.fn() }) }));
import { startEnrolledHostConnection } from './server-connection.js';

it('forwards event pressure and overflow to the enrolled terminal producer and releases it on close', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'host-pressure-wiring-'));
  const connection = startEnrolledHostConnection({ dataDir, serverUrl: 'http://127.0.0.1:1', hostId: 'host', hostKey: 'fixture' });
  try {
    await connection.ready;
    expect(state.paused).not.toHaveBeenCalled(); expect(state.overflow).not.toHaveBeenCalled();
    state.callbacks!.onPressure!(true); state.callbacks!.onPressure!(false); state.callbacks!.onTerminalOverflow!('terminal');
    expect(state.paused.mock.calls).toEqual([[true], [false]]);
    expect(state.overflow).toHaveBeenCalledExactlyOnceWith('terminal');
    await connection.close(); await connection.close();
    expect(state.ptyDispose).toHaveBeenCalledOnce(); expect(state.adapterDispose).toHaveBeenCalledOnce();
  } finally { await connection.close(); rmSync(dataDir, { recursive: true, force: true }); }
});
