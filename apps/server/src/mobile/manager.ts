import { networkInterfaces } from 'node:os';
import { startMobileGateway } from './gateway.js';
import type { MobileDeviceStore } from './device-store.js';
import { MobileConnectionStore, validateMobileConnection, type MobileConnectionView } from './connection.js';
import { connectRelay, type RelayState } from '../../../../services/mobile-relay/client.mjs';

/** Fixed port the phone and the `mobile:serve` CLI both expect. */
export const MOBILE_GATEWAY_PORT = 8785;

export interface MobileBinding {
  /** Interface the gateway binds — a private LAN IP, else loopback. */
  host: string;
  /** Exact origin the phone uses; must match the gateway's `Host` check. */
  publicUrl: string;
  /** True when bound to a reachable LAN IP (a real phone can connect). */
  boundLan: boolean;
}

export interface MobileGatewayStatus {
  running: boolean;
  publicUrl: string | null;
  host: string | null;
  port: number | null;
  boundLan: boolean;
  /** Last start failure (e.g. port in use), cleared on a successful start. */
  error: string | null;
  connection?: MobileConnectionView;
  relayState?: RelayState;
}

export interface MobilePairingPayload {
  version: number;
  serverUrl: string;
  code: string;
  expiresAt: number;
}

type GatewayHandle = Awaited<ReturnType<typeof startMobileGateway>>;

function isPrivateIpv4(address: string): boolean {
  if (address.startsWith('10.') || address.startsWith('192.168.')) return true;
  const second = /^172\.(\d+)\./.exec(address);
  return !!second && Number(second[1]) >= 16 && Number(second[1]) <= 31;
}

/**
 * Prefer a private LAN IPv4 so a phone on the same network can reach the
 * gateway; fall back to loopback (only the simulator / a reverse proxy can
 * reach it then). Binds one specific interface, never `0.0.0.0`.
 */
export function resolveMobileBinding(
  port: number = MOBILE_GATEWAY_PORT,
  interfaces: typeof networkInterfaces = networkInterfaces
): MobileBinding {
  for (const infos of Object.values(interfaces())) {
    for (const info of infos ?? []) {
      if (info.family === 'IPv4' && !info.internal && isPrivateIpv4(info.address))
        return { host: info.address, publicUrl: `http://${info.address}:${port}`, boundLan: true };
    }
  }
  return { host: '127.0.0.1', publicUrl: `http://127.0.0.1:${port}`, boundLan: false };
}

export interface MobileGatewayManagerDeps {
  /** File-backed device store (shared with the `mobile:serve` CLI). */
  devices: MobileDeviceStore;
  /** Loopback product-server origin the gateway proxies to. */
  upstream: string;
  port?: number;
  startGateway?: typeof startMobileGateway;
  resolveBinding?: (port: number) => MobileBinding;
  connectionStore?: MobileConnectionStore;
  connectRelay?: typeof connectRelay;
}

/**
 * Owns the desktop-embedded mobile gateway lifecycle (Rule 3: one instance,
 * started/stopped from the config reactor, closed on quit). Thin wrapper over
 * {@link startMobileGateway} so the IPC handlers and `config.ts` stay small;
 * dependencies are injected for tests.
 */
export class MobileGatewayManager {
  private handle: GatewayHandle | null = null;
  private binding: MobileBinding | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private relay: ReturnType<typeof connectRelay> | null = null;
  private readonly connections: MobileConnectionStore;
  private lastError: string | null = null;
  private readonly port: number;
  private readonly startGateway: typeof startMobileGateway;
  private readonly resolveBinding: (port: number) => MobileBinding;

  constructor(private readonly deps: MobileGatewayManagerDeps) {
    this.port = deps.port ?? MOBILE_GATEWAY_PORT;
    this.connections = deps.connectionStore ?? new MobileConnectionStore();
    this.startGateway = deps.startGateway ?? startMobileGateway;
    this.resolveBinding = deps.resolveBinding ?? resolveMobileBinding;
  }

  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run);
    this.queue = next.catch(() => {});
    return next;
  }

  start(): Promise<MobileGatewayStatus> { return this.serialize(() => this.startNow()); }

  private async startNow(): Promise<MobileGatewayStatus> {
    if (this.handle) return this.status();
    try {
      const connection = this.connections.read();
      const binding = connection.mode === 'local' ? this.resolveBinding(this.port) : {
        host: '127.0.0.1', publicUrl: connection.publicUrl!, boundLan: false
      };
      this.handle = await this.startGateway({
        upstream: this.deps.upstream, publicUrl: binding.publicUrl,
        host: binding.host, port: this.port, devices: this.deps.devices
      });
      this.binding = binding;
      this.lastError = null;
      if (connection.mode === 'relay') this.relay = (this.deps.connectRelay ?? connectRelay)({
        publicUrl: connection.publicUrl!, token: connection.relayToken!, gatewayPort: this.handle.port
      });
    } catch (error) {
      if (this.handle) await this.handle.close();
      this.handle = null;
      this.binding = null;
      this.lastError = (error as NodeJS.ErrnoException)?.code === 'EADDRINUSE'
        ? `Port ${this.port} is already in use — is \`pnpm mobile:serve\` running? Stop it, then enable phone access again.`
        : error instanceof Error ? error.message : 'Failed to start the mobile gateway';
      throw new Error(this.lastError);
    }
    return this.status();
  }

  stop(): Promise<MobileGatewayStatus> { return this.serialize(() => this.stopNow()); }

  private async stopNow(): Promise<MobileGatewayStatus> {
    this.relay?.close();
    this.relay = null;
    const handle = this.handle;
    this.handle = null;
    this.binding = null;
    this.lastError = null;
    if (handle) await handle.close();
    return this.status();
  }

  configure(input: unknown, enabled: boolean): Promise<MobileGatewayStatus> {
    return this.serialize(async () => {
      // A damaged file must not prevent saving a fresh, fully validated setup.
      let previous;
      try { previous = this.connections.read(); } catch { /* no secret to preserve */ }
      const next = validateMobileConnection(input, previous);
      await this.connections.write(next);
      await this.stopNow();
      return enabled ? this.startNow() : this.status();
    });
  }

  status(): MobileGatewayStatus {
    let connection: MobileConnectionView | undefined;
    try { connection = this.connections.view(); } catch { this.lastError = 'Could not read phone connection configuration'; }
    return {
      running: !!this.handle,
      publicUrl: this.binding?.publicUrl ?? null,
      host: this.binding?.host ?? null,
      port: this.handle?.port ?? null,
      boundLan: this.binding?.boundLan ?? false,
      error: this.lastError,
      connection,
      ...(this.relay ? { relayState: this.relay.state() } : {})
    };
  }

  pair(): MobilePairingPayload {
    if (!this.handle) throw new Error('Enable phone access before pairing a device');
    if (this.relay && this.relay.state() !== 'connected') throw new Error('Wait for the relay connection before pairing');
    return this.handle.pair();
  }

  /** Paired devices, secrets already stripped. Readable even while stopped. */
  devices(): ReturnType<MobileDeviceStore['list']> {
    return this.handle ? this.handle.devices() : this.deps.devices.list();
  }

  /** Revoke a paired device; works whether or not the gateway is running. */
  revoke(id: string): boolean {
    return this.handle ? this.handle.revoke(id) : this.deps.devices.revoke(id);
  }

  async close(): Promise<void> {
    await this.stop();
  }
}
