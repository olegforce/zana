import { spawn, type ChildProcess } from 'node:child_process';
import type { ProjectRemote } from '@zana-ai/zcc-domain/product';
import { sshBaseArgs } from './remote-fs.js';

const READY = 'ZCC-PEER-TUNNEL-READY';
type Tunnel = { process?: ChildProcess; pending?: Promise<void>; timer?: ReturnType<typeof setTimeout>; stopped: boolean };

/** One owned SSH connection per machine; reconnects until its daemon shuts down. */
export class PeerTunnels {
  private readonly tunnels = new Map<string, Tunnel>();
  constructor(private readonly spawnProcess: typeof spawn = spawn) {}

  async open(remote: ProjectRemote, localPort: number, remotePort: number): Promise<void> {
    if (![localPort, remotePort].every(port => Number.isInteger(port) && port > 0 && port <= 65535)) {
      throw new Error('Invalid peer tunnel port');
    }
    const key = JSON.stringify([remote.host, remote.user, remote.proxyJump, localPort, remotePort]);
    const prior = this.tunnels.get(key);
    if (prior?.process && !prior.process.killed) return prior.pending;
    if (prior) this.stop(prior);
    if (!prior && this.tunnels.size >= 64) throw new Error('Too many peer SSH tunnels');
    const tunnel: Tunnel = { stopped: false };
    this.tunnels.set(key, tunnel);
    const connect = (): Promise<void> => new Promise((resolve, reject) => {
      // A dedicated connection owns the forwarding: closing it must remove -R.
      const proc = this.spawnProcess('ssh', [
        '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
        '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15',
        '-o', 'ServerAliveCountMax=3', '-R', `127.0.0.1:${remotePort}:127.0.0.1:${localPort}`,
        ...sshBaseArgs(remote), `printf '${READY}\\n'; exec sleep 2147483647`
      ], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      tunnel.process = proc;
      let ready = false, output = '', error = '', settled = false;
      const finish = (failure?: Error) => {
        if (settled) return;
        settled = true; clearTimeout(timeout);
        failure ? reject(failure) : resolve();
      };
      const timeout = setTimeout(() => { finish(new Error('SSH tunnel timed out')); this.kill(proc); }, 30_000);
      proc.stdout?.on('data', chunk => {
        output = (output + chunk).slice(-4096);
        if (output.includes(READY)) { ready = true; finish(); }
      });
      proc.stderr?.on('data', chunk => { error = (error + chunk).slice(-4096); });
      proc.once('error', failure => { finish(failure); });
      proc.once('close', () => {
        tunnel.process = undefined;
        finish(new Error(error.trim() || 'SSH tunnel closed before connecting'));
        if (ready && !tunnel.stopped) {
          const retry = () => { tunnel.timer = setTimeout(() => {
            tunnel.timer = undefined;
            tunnel.pending = connect();
            void tunnel.pending.catch(() => { if (!tunnel.stopped) retry(); });
          }, 3000); };
          retry();
        }
      });
    });
    tunnel.pending = connect();
    try { await tunnel.pending; }
    catch (error) { this.stop(tunnel); if (this.tunnels.get(key) === tunnel) this.tunnels.delete(key); throw error; }
  }

  private stop(tunnel: Tunnel): void {
    tunnel.stopped = true;
    clearTimeout(tunnel.timer);
    if (tunnel.process) this.kill(tunnel.process);
  }

  private kill(proc: ChildProcess): void {
    // Also reap ProxyCommand children; killing only ssh can strand a tunnel.
    if (proc.pid && process.platform !== 'win32') {
      try { process.kill(-proc.pid, 'SIGKILL'); return; } catch { /* already gone */ }
    }
    proc.kill('SIGKILL');
  }

  remove(remote: ProjectRemote, localPort: number, remotePort: number): void {
    const key = JSON.stringify([remote.host, remote.user, remote.proxyJump, localPort, remotePort]);
    const tunnel = this.tunnels.get(key);
    if (tunnel) this.stop(tunnel);
    this.tunnels.delete(key);
  }

  close(): void {
    for (const tunnel of this.tunnels.values()) this.stop(tunnel);
    this.tunnels.clear();
  }
}
