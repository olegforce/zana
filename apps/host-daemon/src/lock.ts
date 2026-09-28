import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export const DAEMON_LOCK_FILE_NAME = 'daemon.lock';

export class DaemonLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonLockError';
  }
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    // A child can be a zombie until its parent returns to the event loop.
    return !processIdentity(pid)?.endsWith('<defunct>');
  } catch {
    return false;
  }
}

function readLockPid(lockPath: string): number | null {
  try {
    const pid = Number(readFileSync(lockPath, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function processIdentity(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 1 || process.platform === 'win32') return null;
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'lstart=,command='], {
      encoding: 'utf8', timeout: 1000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'ignore']
    }).trim() || null;
  } catch { return null; }
}

function signalOwner(pid: number, identity: string, signal: NodeJS.Signals): void {
  if (processIdentity(pid) !== identity) throw new DaemonLockError('Daemon process identity changed; refusing to signal a reused PID');
  try { process.kill(pid, signal); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

function waitUntilDead(pid: number, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidIsAlive(pid)) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  return !pidIsAlive(pid);
}

function lockHeldMessage(lockPath: string, pid?: number): string {
  const pidBit = pid != null ? ` (pid ${pid})` : '';
  return (
    `another host-daemon holds ${lockPath}${pidBit}. ` +
    'Quit that app, or run `pnpm dev` without overriding ZCC_DATA_DIR (defaults to ~/.zcc-dev).'
  );
}

function unlinkIfOwner(lockPath: string, pid: number): void {
  try {
    if (readLockPid(lockPath) === pid) unlinkSync(lockPath);
  } catch {
    /* already gone or stolen */
  }
}

/**
 * Exclusive lock for one enrolled host-daemon per data dir. A stale lock
 * (dead pid) is replaced. `steal: true` is for the desktop co-started daemon:
 * it can take over only a recorded matching process identity. Legacy PID-only
 * locks fail closed and require stopping their owning app/service. A verified
 * leftover development daemon can still hand over to the desktop.
 */
export function acquireDaemonLock(dataDir: string, options?: { steal?: boolean }): () => void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const lockPath = join(dataDir, DAEMON_LOCK_FILE_NAME);
  const identityPath = `${lockPath}.identity.json`;
  const existingPid = readLockPid(lockPath);
  if (existingPid !== null && pidIsAlive(existingPid)) {
    if (existingPid === process.pid || !options?.steal) {
      throw new DaemonLockError(lockHeldMessage(lockPath, existingPid));
    }
    let owner: { pid?: number; identity?: string } = {};
    try { owner = JSON.parse(readFileSync(identityPath, 'utf8')); } catch {}
    if (owner.pid !== existingPid || !owner.identity || processIdentity(existingPid) !== owner.identity) {
      throw new DaemonLockError(`${lockHeldMessage(lockPath, existingPid)} Process ownership cannot be verified; stop its owning app or service first.`);
    }
    signalOwner(existingPid, owner.identity, 'SIGTERM');
    if (!waitUntilDead(existingPid, 1_500)) signalOwner(existingPid, owner.identity, 'SIGKILL');
    waitUntilDead(existingPid, 300);
  }
  unlinkIfOwner(lockPath, existingPid ?? -1);
  try {
    writeFileSync(lockPath, `${process.pid}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new DaemonLockError(lockHeldMessage(lockPath));
    }
    throw error;
  }
  const temporary = `${identityPath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ pid: process.pid, identity: processIdentity(process.pid) }), { mode: 0o600 });
    renameSync(temporary, identityPath);
  } catch (error) {
    unlinkIfOwner(lockPath, process.pid);
    throw error;
  } finally { try { unlinkSync(temporary); } catch {} }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (readLockPid(lockPath) === process.pid) {
      try { unlinkSync(identityPath); } catch {}
      unlinkIfOwner(lockPath, process.pid);
    }
  };
}
