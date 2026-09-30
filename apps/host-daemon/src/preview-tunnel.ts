import { createConnection } from 'node:net';
import { connectRelay } from '../../../services/mobile-relay/client.mjs';
import { previewTargets } from '../../../services/mobile-relay/preview-policy.mjs';
import { isProtectedPreviewPort } from '../../../services/mobile-relay/protected-ports.mjs';

export class HostPreviewTunnel {
  private targets: Array<{ port: number; expiresAt: number }> = [];
  private relay?: ReturnType<typeof connectRelay>;
  private epoch: string | null = null;
  private generation = -1;
  private connected = false;
  private leaseUntil = 0;
  constructor(private readonly serverUrl: string, private readonly credential?: string) {}
  setConnected(connected: boolean) {
    this.connected = connected;
    this.epoch = null; this.generation = -1;
    if (!connected) { this.targets = []; this.relay?.close(); this.relay = undefined; }
  }
  async replace(input: { epoch: string; generation: number; targets: Array<{ port: number; expiresAt: number }> }) {
    if (!this.credential) return { state: 'update-required', unavailablePorts: [], message: 'Enroll this machine through Connect to share previews.' };
    if (!this.connected) return { state: 'offline', unavailablePorts: [] };
    if (this.epoch !== null && this.epoch !== input.epoch) throw new Error('Preview owner session changed; reconnect the machine');
    if (input.generation <= this.generation) throw new Error('Stale preview generation');
    const targets = previewTargets(input.targets);
    if (targets.some(target => isProtectedPreviewPort(target.port))) throw new Error('A preview targets a protected Zana port');
    this.epoch = input.epoch; this.generation = input.generation;
    this.targets = targets;
    this.leaseUntil = Date.now() + 15_000;
    if (targets.length && !this.relay) this.relay = connectRelay({ publicUrl: this.serverUrl, token: this.credential, machineCredential: this.credential, gatewayPort: 1,
      previews: () => this.connected && Date.now() < this.leaseUntil ? this.targets.filter(target => !isProtectedPreviewPort(target.port)) : [] });
    if (!targets.length) { this.relay?.close(); this.relay = undefined; }
    const unavailablePorts: number[] = [];
    await Promise.all(targets.map(({ port }) => new Promise<void>(resolve => {
      const socket = createConnection({ host: '127.0.0.1', port }); let done = false;
      const finish = (ok: boolean) => { if (done) return; done = true; socket.destroy(); if (!ok) unavailablePorts.push(port); resolve(); };
      socket.setTimeout(300, () => finish(false)); socket.once('connect', () => finish(true)); socket.once('error', () => finish(false));
    })));
    return { state: this.relay?.state() ?? 'offline', unavailablePorts };
  }
  close() { this.setConnected(false); }
}
