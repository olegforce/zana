import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireDaemonLock, DaemonLockError } from './lock.js';

describe('daemon.lock', () => {
  it('prevents a second process from locking the same data dir', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'zcc-daemon-lock-'));
    const release = acquireDaemonLock(dataDir);
    expect(() => acquireDaemonLock(dataDir)).toThrow(DaemonLockError);
    expect(() => acquireDaemonLock(dataDir)).toThrow(/defaults to ~\/\.zcc-dev/);
    release();
    const second = acquireDaemonLock(dataDir);
    second();
  });

  it('replaces a stale lock from a dead pid', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'zcc-daemon-stale-'));
    writeFileSync(join(dataDir, 'daemon.lock'), '999999999\n', { mode: 0o600 });
    const release = acquireDaemonLock(dataDir);
    release();
  });

  it('steals a verified live lock so the desktop daemon can own this machine', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'zcc-daemon-steal-'));
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore'
    });
    if (!child.pid) throw new Error('holder pid missing');
    writeFileSync(join(dataDir, 'daemon.lock'), `${child.pid}\n`, { mode: 0o600 });
    expect(() => acquireDaemonLock(dataDir)).toThrow(DaemonLockError);
    expect(() => acquireDaemonLock(dataDir, { steal: true })).toThrow(/cannot be verified/);
    expect(() => process.kill(child.pid!, 0)).not.toThrow();
    writeFileSync(join(dataDir, 'daemon.lock.identity.json'), JSON.stringify({
      pid: child.pid, identity: execFileSync('ps', ['-p', String(child.pid), '-o', 'lstart=,command='], { encoding: 'utf8' }).trim()
    }));
    const release = acquireDaemonLock(dataDir, { steal: true });
    expect(() => acquireDaemonLock(dataDir)).toThrow(DaemonLockError);
    child.kill('SIGKILL');
    release();
  });

  it('refuses a live PID whose saved process identity no longer matches', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'zcc-daemon-reused-'));
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      writeFileSync(join(dataDir, 'daemon.lock'), `${child.pid}\n`);
      writeFileSync(join(dataDir, 'daemon.lock.identity.json'), JSON.stringify({ pid: child.pid, identity: 'old process identity' }));
      expect(() => acquireDaemonLock(dataDir, { steal: true })).toThrow(/cannot be verified/);
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
    } finally { child.kill('SIGKILL'); }
  });

  it('escalates only for the same verified TERM-resistant owner', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'zcc-daemon-resistant-'));
    const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      await new Promise(resolve => child.stdout!.once('data', resolve));
      writeFileSync(join(dataDir, 'daemon.lock'), `${child.pid}\n`);
      writeFileSync(join(dataDir, 'daemon.lock.identity.json'), JSON.stringify({ pid: child.pid, identity: execFileSync('ps', ['-p', String(child.pid), '-o', 'lstart=,command='], { encoding: 'utf8' }).trim() }));
      const release = acquireDaemonLock(dataDir, { steal: true });
      release();
      await new Promise(resolve => child.once('exit', resolve));
      expect(child.signalCode).toBe('SIGKILL');
    } finally { child.kill('SIGKILL'); }
  });

  it('desktop enroll steals the lock; join/enroll-entry do not', () => {
    const utility = readFileSync(new URL('./utility-entry.ts', import.meta.url), 'utf8');
    const enrollEntry = readFileSync(new URL('./enroll-entry.ts', import.meta.url), 'utf8');
    const joinCli = readFileSync(new URL('./join-cli.ts', import.meta.url), 'utf8');
    expect(utility).toContain('stealLock: true');
    expect(utility).toContain("type === 'relaunch'");
    expect(enrollEntry).not.toContain('stealLock');
    expect(joinCli).not.toContain('stealLock');
  });
});
