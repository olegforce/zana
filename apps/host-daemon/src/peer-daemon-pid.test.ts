import { describe, expect, it } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, access, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { safeStopStandaloneDaemonLines } from './peer-daemon.js';
const run = promisify(execFile);
describe('remote repair PID identity', () => {
  it('uses the same identity guard in the standalone installer', async () => {
    const installer = await readFile(new URL('../../server/src/assets/install-machine.sh', import.meta.url), 'utf8');
    expect(installer).toContain(safeStopStandaloneDaemonLines().join('\n').replaceAll('$node_bin', '$NODE_BIN'));
    expect(installer).toContain('Environment=ZCC_HOST_SERVICE_MANAGED=1');
    expect(installer.indexOf('[ -f "$package_dir/join.mjs" ]')).toBeLessThan(installer.indexOf('[ -f "$package_dir/join.cjs" ]'));
  });
  it('does not signal an unrelated live process from a stale PID file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zcc-pid-'));
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    await new Promise<void>(resolve => child.once('spawn', resolve));
    try {
      await writeFile(join(dir, 'host-daemon.pid'), String(child.pid));
      await run('/bin/sh', ['-c', safeStopStandaloneDaemonLines().join('\n')], { env: { ...process.env, data_dir: dir, node_bin: process.execPath, join_bin: join(dir, 'runtime/join.mjs') } });
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
      await expect(access(join(dir, 'host-daemon.pid'))).rejects.toThrow();
    } finally { child.kill(); await new Promise(resolve => child.once('exit', resolve)); await rm(dir, { recursive: true, force: true }); }
  });
  it.each(['-1', '0', '1', '42;touch bad'])('rejects unsafe PID %s', async pid => {
    const dir = await mkdtemp(join(tmpdir(), 'zcc-pid-'));
    try {
      await writeFile(join(dir, 'host-daemon.pid'), pid);
      const script = 'kill() { echo unsafe-signal; };\n' + safeStopStandaloneDaemonLines().join('\n');
      const result = await run('/bin/sh', ['-c', script], { env: { ...process.env, data_dir: dir, node_bin: 'node', join_bin: 'join.mjs' } });
      expect(result.stdout).toBe('');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
