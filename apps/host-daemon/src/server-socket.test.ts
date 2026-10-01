import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOST_RPC_PROTOCOL_VERSION } from '@zana-ai/zcc-contracts/host-rpc';
import { createHostServerSocket, HostAuthenticationError } from './server-socket.js';

const mocks = vi.hoisted(() => ({ sockets: [] as any[] }));
vi.mock('partysocket/ws', () => ({ default: class {
  readyState = 0;
  onopen: any; onmessage: any; onerror: any; onclose: any;
  send = vi.fn(); close = vi.fn(); reconnect = vi.fn();
  constructor(readonly url: string, readonly protocols: string[], readonly options: any) { mocks.sockets.push(this); }
} }));
const hostId = '11111111-1111-4111-8111-111111111111';
const instanceId = '22222222-2222-4222-8222-222222222222';
const readyOk = { type: 'host.ready-ok', protocolVersion: HOST_RPC_PROTOCOL_VERSION, hostId, instanceId };
const hello = { type: 'host.hello-ok', protocolVersion: HOST_RPC_PROTOCOL_VERSION, hostId };
let connections: ReturnType<typeof createHostServerSocket>[];
beforeEach(() => { vi.useFakeTimers(); mocks.sockets.length = 0; connections = []; });
afterEach(() => { connections.forEach(c => c.close()); vi.useRealTimers(); });
function setup(overrides: Partial<Parameters<typeof createHostServerSocket>[0]> = {}) {
  const options = { serverUrl: 'https://example.test/t/zcrs_abcdefghijklmnop', hostId, instanceId, hostKey: 'private-key',
    onHello: vi.fn(async () => {}), onConnectionChange: vi.fn(), onSocketClose: vi.fn(), onMessage: vi.fn(), ...overrides };
  const connection = createHostServerSocket(options);
  void connection.ready.catch(() => {});
  connections.push(connection);
  const socket = mocks.sockets.at(-1)!;
  const message = (data: unknown) => socket.onmessage({ data: JSON.stringify(data) });
  const open = () => { socket.readyState = 1; socket.onopen(); };
  const accept = async () => { open(); message(hello); await Promise.resolve(); message(readyOk); await connection.ready; };
  return { connection, socket, options, message, open, accept };
}

describe('BB host connection lifecycle', () => {
  it('uses the BB retry policy without queuing mutations or exposing credentials in URLs', () => {
    const { socket, connection } = setup();
    expect(socket.url).toBe('wss://example.test/t/zcrs_abcdefghijklmnop/internal/hosts/ws');
    expect(socket.options).toMatchObject({ minReconnectionDelay: 1000, maxReconnectionDelay: 30000, reconnectionDelayGrowFactor: 2, connectionTimeout: 10000, maxRetries: Infinity, maxEnqueuedMessages: 0 });
    expect(connection.send('offline mutation')).toBe(false);
    expect(socket.send).not.toHaveBeenCalled();
  });
  it('accepts hello only after generation reconciliation, then acknowledges readiness and sends', async () => {
    let finish!: () => void;
    const reconcile = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const f = setup({ onHello: reconcile });
    f.open(); f.message({ type: 'heartbeat-ack' }); f.message({ ...hello, hostId: instanceId });
    expect(f.connection.connected).toBe(false);
    f.message(hello); f.message(hello);
    expect(reconcile).toHaveBeenCalledOnce();
    expect(f.connection.connected).toBe(false);
    finish(); await Promise.resolve();
    expect(f.connection.connected).toBe(false);
    expect(JSON.parse(f.socket.send.mock.calls.at(-1)[0])).toMatchObject({ type: 'host.ready' });
    f.message(readyOk); await f.connection.ready;
    f.message(hello);
    expect(reconcile).toHaveBeenCalledOnce();
    expect(f.options.onConnectionChange).toHaveBeenCalledWith(true);
    expect(f.connection.send('live message')).toBe(true);
    expect(f.socket.send).toHaveBeenLastCalledWith('live message');
  });
  it('expires a missing hello on every socket opening, including reconnect', async () => {
    const f = setup(); await f.accept();
    f.socket.onclose({ code: 1006 }); f.open();
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.socket.close).toHaveBeenLastCalledWith(1013, 'hello-timeout');
    expect(f.connection.connected).toBe(false);
    expect(f.options.onSocketClose).toHaveBeenCalledWith(1006);
  });
  it('retains initial retries but bounds startup and releases every timer', async () => {
    const f = setup(); f.socket.onerror({ message: 'temporary URL with secret' }); f.socket.onclose({ code: 1006 });
    const rejected = expect(f.connection.ready).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(60000); await rejected;
    expect(f.socket.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(f.connection.send('after close')).toBe(false);
  });
  it.each([401, 403])('stops on explicit credential rejection %s without leaking the raw error', async status => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = setup(); f.open();
    f.socket.onerror({ message: `Unexpected server response: ${status} private-key` });
    await expect(f.connection.ready).rejects.toBeInstanceOf(HostAuthenticationError);
    expect(warn.mock.calls.flat().join(' ')).not.toContain('private-key');
    warn.mockRestore();
    expect(f.socket.close).toHaveBeenCalledOnce();
  });
  it.each([4001, 4002])('hands protocol close %s to the updater immediately', async code => {
    const f = setup(); f.socket.onclose({ code });
    expect(f.options.onSocketClose).toHaveBeenCalledWith(code);
    await expect(f.connection.ready).rejects.toThrow('incompatible');
  });
  it('checks heartbeat replies and reconnects when they stop', async () => {
    const f = setup(); await f.accept();
    for (let i = 0; i < 8; i++) { await vi.advanceTimersByTimeAsync(5000); f.message({ type: 'heartbeat-ack' }); }
    expect(f.socket.reconnect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(35000);
    expect(f.socket.close).toHaveBeenLastCalledWith(1013, 'heartbeat-ack-timeout');
    expect(f.options.onConnectionChange).toHaveBeenLastCalledWith(false);
  });
  it('allows a fresh lease after a suspension gap, then requires replies', async () => {
    const f = setup(); await f.accept();
    vi.setSystemTime(Date.now() + 60000); await vi.advanceTimersByTimeAsync(5000);
    expect(f.socket.reconnect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(35000);
    expect(f.socket.close).toHaveBeenLastCalledWith(1013, 'heartbeat-ack-timeout');
  });
  it('discards stale reconciliation and RPC replies across reconnects', async () => {
    let finish!: () => void;
    const f = setup({ onHello: vi.fn().mockImplementationOnce(() => new Promise<void>(r => { finish = r; })).mockResolvedValue(undefined) });
    f.open(); f.message(hello); f.socket.onclose({ code: 1006 }); finish();
    await Promise.resolve(); expect(f.connection.connected).toBe(false);
    await f.accept(); f.message({ type: 'host-rpc.request' });
    const reply = (f.options.onMessage as ReturnType<typeof vi.fn>).mock.calls[0][1];
    reply('current'); expect(f.socket.send).toHaveBeenLastCalledWith('current');
    f.socket.onclose({ code: 1006 }); await f.accept();
    f.socket.send.mockClear(); reply('stale'); expect(f.socket.send).not.toHaveBeenCalled();
  });
  it('retries failed reconciliation, ignores malformed input, and shuts down idempotently', async () => {
    const f = setup({ onHello: vi.fn().mockRejectedValue(new Error('worker failed')) });
    f.open(); f.socket.onmessage({ data: 'bad JSON' }); f.message(hello);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.socket.close).toHaveBeenLastCalledWith(1013, 'plugin-reconciliation-failed');
    f.connection.close(); f.connection.close(); f.connection.reconnect('late');
    f.socket.onopen(); f.message(hello); f.socket.onerror({ message: 'late' }); f.socket.onclose({ code: 1006 });
    await expect(f.connection.ready).rejects.toThrow('closed before hello');
    expect(f.socket.close).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps an installed daemon retrying past the initial deadline and a failed protocol update', async () => {
    const f = setup({ keepRetryingStartup: true });
    f.socket.onerror({ message: 'temporary network outage' });
    f.socket.onclose({ code: 4001 });
    await vi.advanceTimersByTimeAsync(180000);
    expect(f.socket.close).not.toHaveBeenCalled();
    await f.accept();
    expect(f.connection.connected).toBe(true);
  });
  it('stops a superseded process, but retries a replaced socket of the same lifetime', async () => {
    const terminal = vi.fn();
    const f = setup({ onTerminated: terminal }); await f.accept();
    f.socket.onclose({ code: 4004 });
    expect(terminal).not.toHaveBeenCalled();
    await f.accept(); f.socket.onclose({ code: 4003 });
    expect(terminal).toHaveBeenCalledOnce();
    expect(f.socket.close).toHaveBeenCalledOnce();
    f.connection.reconnect('late retry');
    expect(f.socket.reconnect).toHaveBeenCalledTimes(1);
  });
  it('validates the ready acknowledgement and times out a missing acknowledgement', async () => {
    const f = setup(); f.open(); f.message(readyOk);
    expect(f.connection.connected).toBe(false);
    f.message(hello); await Promise.resolve();
    f.message({ ...readyOk, instanceId: hostId });
    f.message({ ...readyOk, hostId: instanceId });
    expect(f.connection.connected).toBe(false);
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.socket.close).toHaveBeenLastCalledWith(1013, 'hello-timeout');
  });

  it('backs off repeated readiness failures instead of spinning at socket speed', async () => {
    const f = setup({ onHello: vi.fn().mockRejectedValue(new Error('invalid inventory')), keepRetryingStartup: true });
    f.open(); f.message(hello); await Promise.resolve(); await Promise.resolve();
    expect(f.socket.reconnect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999); expect(f.socket.reconnect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(f.socket.reconnect).toHaveBeenCalledTimes(2);
    f.open(); f.message(hello); await Promise.resolve(); await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1999); expect(f.socket.reconnect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); expect(f.socket.reconnect).toHaveBeenCalledTimes(3);
  });

});
