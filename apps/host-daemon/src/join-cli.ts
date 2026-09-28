import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { installRuntimeLog } from '@zana-ai/zcc-process-utils';
import { spawn } from 'node:child_process';
import { HOST_RPC_PROTOCOL_VERSION } from '@zana-ai/zcc-contracts/host-rpc';
import { startEnrolledHostDaemon, type EnrolledHostDaemon } from './enroll-runtime.js';
import { parseJoinArgv, type JoinCliOptions } from './join-argv.js';
import { startLocalStatusServer } from './local-status.js';
import { handleProtocolMismatch, confirmHostUpdate, rollbackHostUpdate } from './protocol-self-update.js';

export type { JoinCliOptions } from './join-argv.js';
export { parseJoinArgv } from './join-argv.js';

/** Service managers restart the stable entry; standalone installs replace themselves. */
export async function restartHostProcess(): Promise<void> {
  if (process.env.ZCC_HOST_SERVICE_MANAGED !== '1') {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, process.argv.slice(1), { detached: true, stdio: 'inherit', env: process.env });
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve(); });
    });
  }
  process.exit(0);
}

export async function runJoin(options: JoinCliOptions, restart = restartHostProcess): Promise<{ close(): Promise<void> }> {
  if (!options.dataDir) throw new Error('ZCC_DATA_DIR is required for an isolated machine install');
  let connected = false;
  let closing = false;
  let hostId = options.hostId ?? null;
  let daemon: EnrolledHostDaemon | null = null;
  let updateTask: Promise<void> | null = null;
  const status = startLocalStatusServer(options.hostDaemonPort, () => ({
    hostId, serverUrl: options.serverUrl, connected,
    protocolVersion: HOST_RPC_PROTOCOL_VERSION, autoUpdate: options.autoUpdate
  }));
  async function close(): Promise<void> {
    if (closing) return;
    closing = true;
    connected = false;
    await daemon?.close();
    await new Promise<void>(resolve => status.close(() => resolve()));
  }
  function update(force: boolean): Promise<void> {
    if (closing) return Promise.resolve();
    if (updateTask) return updateTask;
    updateTask = (async () => {
      const result = await handleProtocolMismatch({ ...options, enabled: options.autoUpdate, force });
      if (result !== 'updated') return;
      await close();
      await restart();
    })().catch(error => { console.error('Host restart failed:', error); }).finally(() => { updateTask = null; });
    return updateTask;
  }
  try {
    daemon = await startEnrolledHostDaemon({
      dataDir: options.dataDir,
      serverUrl: options.serverUrl.endsWith('/') ? options.serverUrl : `${options.serverUrl}/`,
      token: options.joinCode, hostId: options.hostId,
      onConnectionChange: value => { connected = value && !closing; },
      onSocketClose: code => {
        connected = false;
        if (!closing && options.autoUpdate && (code === 4001 || code === 4002)) void update(code === 4001);
      }
    });
    hostId = daemon.hostId;
    connected = !closing;
    await confirmHostUpdate(options.dataDir).catch(error => console.error('Host update cleanup failed:', error));
    process.stdout.write(`zcc-host-daemon joined hostId=${daemon.hostId}\n`);
    return { close };
  } catch (error) {
    if (updateTask) await updateTask;
    else if (options.autoUpdate && /incompatible host-rpc protocol version|409/.test(String(error))) await update(true);
    await close();
    throw error;
  }
}

const entry = process.argv[1] ?? '';
const launchedDirectly = /(?:join-cli\.[tj]s|join\.[cm]js)$/.test(entry);
if (launchedDirectly && process.argv.includes('--check-protocol')) {
  const value = process.argv[process.argv.indexOf('--check-protocol') + 1];
  process.exit(Number(value) === HOST_RPC_PROTOCOL_VERSION ? 0 : 1);
}
if (launchedDirectly && process.argv.includes('join')) {
  const options = parseJoinArgv(process.argv.slice(2));
  installRuntimeLog(options.dataDir, 'host-daemon', import.meta.url);
  // A standalone self-restart has a new PID; never leave the installer's old record behind.
  const pidFile = join(options.dataDir, 'host-daemon.pid');
  if (process.env.ZCC_HOST_SERVICE_MANAGED !== '1') {
    mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
    const temporary = `${pidFile}.${process.pid}.tmp`;
    writeFileSync(temporary, String(process.pid), { mode: 0o600 });
    renameSync(temporary, pidFile);
    process.on('exit', () => {
      try { if (readFileSync(pidFile, 'utf8').trim() === String(process.pid)) rmSync(pidFile); } catch {}
    });
  }
  try {
    const running = await runJoin(options);
    const shutdown = () => { void running.close().finally(() => process.exit(0)); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (error) {
    if (await rollbackHostUpdate(options.dataDir)) await restartHostProcess();
    throw error;
  }
}
