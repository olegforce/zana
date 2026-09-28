import { describe, expect, it, vi } from 'vitest';
import { MobileGatewayManager, resolveMobileBinding } from './manager.js';
import { MobileDeviceStore } from './device-store.js';
import type { startMobileGateway } from './gateway.js';
import { MobileConnectionStore } from './connection.js';

type NetInfoFn = typeof import('node:os').networkInterfaces;
const ifaces = (address: string, opts: Partial<{ family: string; internal: boolean }> = {}) =>
  (() => ({
    en0: [{ family: 'IPv4', internal: false, address, ...opts } as never]
  })) as unknown as NetInfoFn;

function fakeHandle(port = 8785) {
  return {
    port,
    pair: vi.fn(() => ({ version: 1, serverUrl: 'http://x', code: 'code', expiresAt: 1 })),
    devices: vi.fn(() => [{ id: 'd1', label: 'Phone', createdAt: 0, expiresAt: 0 }]),
    revoke: vi.fn(() => true),
    close: vi.fn(async () => {})
  };
}

describe('resolveMobileBinding', () => {
  it('prefers a private LAN IPv4 and marks it LAN-bound', () => {
    expect(resolveMobileBinding(8785, ifaces('192.168.1.42'))).toEqual({
      host: '192.168.1.42',
      publicUrl: 'http://192.168.1.42:8785',
      boundLan: true
    });
  });

  it('falls back to loopback when no private IPv4 exists', () => {
    expect(resolveMobileBinding(8785, ifaces('8.8.8.8'))).toEqual({
      host: '127.0.0.1',
      publicUrl: 'http://127.0.0.1:8785',
      boundLan: false
    });
  });

  it('recognises 172.16–31 as private but not 172.32', () => {
    expect(resolveMobileBinding(1, ifaces('172.16.0.1')).boundLan).toBe(true);
    expect(resolveMobileBinding(1, ifaces('172.31.255.1')).boundLan).toBe(true);
    expect(resolveMobileBinding(1, ifaces('172.32.0.1')).boundLan).toBe(false);
  });
});

describe('MobileGatewayManager', () => {
  const binding = { host: '192.168.1.42', publicUrl: 'http://192.168.1.42:8785', boundLan: true };
  const make = (startGateway: typeof startMobileGateway) =>
    new MobileGatewayManager({
      devices: new MobileDeviceStore(),
      upstream: 'http://127.0.0.1:8780',
      startGateway,
      resolveBinding: () => binding
    });

  it('starts once and reports LAN status; a second start is a no-op', async () => {
    const start = vi.fn(async () => fakeHandle(8785)) as unknown as typeof startMobileGateway;
    const manager = make(start);
    const status = await manager.start();
    expect(status).toEqual({
      running: true,
      publicUrl: 'http://192.168.1.42:8785',
      host: '192.168.1.42',
      port: 8785,
      boundLan: true,
      error: null,
      connection: { mode: 'local', hasRelayToken: false }
    });
    await manager.start();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('stops and closes the underlying handle', async () => {
    const handle = fakeHandle();
    const manager = make((async () => handle) as unknown as typeof startMobileGateway);
    await manager.start();
    const status = await manager.stop();
    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(status.running).toBe(false);
    expect(status.publicUrl).toBeNull();
  });

  it('surfaces a friendly message when the port is already in use', async () => {
    const start = vi.fn(async () => {
      throw Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
    }) as unknown as typeof startMobileGateway;
    const manager = make(start);
    await expect(manager.start()).rejects.toThrow(/already in use.*mobile:serve/s);
    expect(manager.status().running).toBe(false);
    expect(manager.status().error).toMatch(/already in use/);
  });

  it('delegates pair/devices/revoke to the handle while running', async () => {
    const handle = fakeHandle();
    const manager = make((async () => handle) as unknown as typeof startMobileGateway);
    await manager.start();
    expect(manager.pair().code).toBe('code');
    expect(manager.devices()).toHaveLength(1);
    expect(manager.revoke('d1')).toBe(true);
    expect(handle.pair).toHaveBeenCalled();
    expect(handle.revoke).toHaveBeenCalledWith('d1');
  });

  it('rejects pairing while stopped but still reads/revokes devices from the store', async () => {
    const devices = new MobileDeviceStore();
    const added = devices.add('Phone');
    const manager = new MobileGatewayManager({
      devices,
      upstream: 'http://127.0.0.1:8780',
      startGateway: (async () => fakeHandle()) as unknown as typeof startMobileGateway,
      resolveBinding: () => binding
    });
    expect(() => manager.pair()).toThrow(/Enable phone access/);
    expect(manager.devices().map((d) => d.id)).toContain(added.deviceId);
    expect(manager.revoke(added.deviceId)).toBe(true);
    expect(manager.devices()).toHaveLength(0);
  });
});

describe('remote phone connection lifecycle', () => {
  it('allows replacing damaged configuration without preserving an unreadable secret', async () => {
    const store = new MobileConnectionStore();
    const read = vi.spyOn(store, 'read').mockImplementation(() => { throw new Error('damaged file'); });
    const manager = new MobileGatewayManager({ devices: new MobileDeviceStore(), upstream: 'http://127.0.0.1:8780', connectionStore: store });
    expect(manager.status().error).toContain('Could not read');
    await expect(manager.configure({ mode: 'relay', publicUrl: 'https://relay.example' }, false)).rejects.toThrow('relay secret');
    await manager.configure({ mode: 'local' }, false);
    read.mockRestore();
    expect(manager.status().connection?.mode).toBe('local');
  });
  it('binds Tailscale to loopback and switches back to the LAN without changing devices', async () => {
    const handles: ReturnType<typeof fakeHandle>[] = [];
    const start = vi.fn(async () => { const handle = fakeHandle(); handles.push(handle); return handle; });
    const manager = new MobileGatewayManager({ devices: new MobileDeviceStore(), upstream: 'http://127.0.0.1:8780', startGateway: start as unknown as typeof startMobileGateway,
      resolveBinding: () => ({ host: '192.168.1.42', publicUrl: 'http://192.168.1.42:8785', boundLan: true }) });
    await manager.configure({ mode: 'tailscale', publicUrl: 'https://mac.test.ts.net' }, true);
    expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ host: '127.0.0.1', publicUrl: 'https://mac.test.ts.net' }));
    expect(manager.status().connection?.mode).toBe('tailscale');
    await manager.configure({ mode: 'local' }, true);
    expect(handles[0].close).toHaveBeenCalledOnce();
    expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ host: '192.168.1.42' }));
    await manager.close();
  });
  it('starts and stops the outbound relay and gates pairing on tunnel readiness', async () => {
    let state: 'connecting' | 'connected' = 'connecting';
    const close = vi.fn();
    const connect = vi.fn(() => ({ state: () => state, close }));
    const manager = new MobileGatewayManager({ devices: new MobileDeviceStore(), upstream: 'http://127.0.0.1:8780', startGateway: (async () => fakeHandle()) as unknown as typeof startMobileGateway, connectRelay: connect });
    await manager.configure({ mode: 'relay', publicUrl: 'https://relay.example', relayToken: 'a'.repeat(43) }, true);
    expect(manager.status().relayState).toBe('connecting');
    expect(() => manager.pair()).toThrow(/Wait for the relay/);
    state = 'connected'; expect(manager.pair().code).toBe('code');
    expect(JSON.stringify(manager.status())).not.toContain('a'.repeat(43));
    await manager.stop(); expect(close).toHaveBeenCalledOnce();
  });
  it('serializes configure/start/stop and validates before disturbing an active connection', async () => {
    const handle = fakeHandle();
    const start = vi.fn(async () => handle);
    const manager = new MobileGatewayManager({ devices: new MobileDeviceStore(), upstream: 'http://127.0.0.1:8780', startGateway: start as unknown as typeof startMobileGateway });
    await Promise.all([manager.start(), manager.start()]);
    expect(start).toHaveBeenCalledOnce();
    await expect(manager.configure({ mode: 'relay', publicUrl: 'http://bad' }, true)).rejects.toThrow();
    expect(manager.status().running).toBe(true); expect(handle.close).not.toHaveBeenCalled();
    await Promise.all([manager.configure({ mode: 'tailscale', publicUrl: 'https://mac.test.ts.net' }, false), manager.stop()]);
    expect(manager.status().running).toBe(false); expect(handle.close).toHaveBeenCalledOnce();
  });
  it('closes the gateway if creating the tunnel fails', async () => {
    const handle = fakeHandle();
    const manager = new MobileGatewayManager({ devices: new MobileDeviceStore(), upstream: 'http://127.0.0.1:8780', startGateway: (async () => handle) as unknown as typeof startMobileGateway,
      connectRelay: () => { throw new Error('Unable to start relay'); } });
    await expect(manager.configure({ mode: 'relay', publicUrl: 'https://relay.example', relayToken: 'a'.repeat(43) }, true)).rejects.toThrow('Unable to start relay');
    expect(handle.close).toHaveBeenCalledOnce(); expect(manager.status().running).toBe(false);
  });
});
