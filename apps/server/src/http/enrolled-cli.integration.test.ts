import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { expect, it, vi } from 'vitest';
import { resolveHostArtifact } from '../services/hosts/host-artifact.js';
import { startProductServer } from './product-server.js';

async function freePort() {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
  const kill = (signal: NodeJS.Signals) => { try { process.kill(-child.pid!, signal); } catch {} };
  kill('SIGTERM'); const timer = setTimeout(() => kill('SIGKILL'), 2000);
  try { await exited; } finally { clearTimeout(timer); }
}

it('rejects deferred CLI execution on both packed machines while retaining real remote terminals', async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'zcc-deferred-cli-machines-'))), children: ChildProcess[] = [];
  const server = await startProductServer({ dataDir: join(base, 'owner'), origins: { serverPort: 0, devAppPort: 5173 } });
  try {
    const artifact = await resolveHostArtifact({ ...process.env, ZCC_HOST_ARTIFACT: '' }), unpack = join(base, 'unpack'); mkdirSync(unpack);
    expect(spawnSync('tar', ['-xzf', artifact.tarballPath, '-C', unpack]).status).toBe(0);
    for (const name of ['first', 'second']) {
      const home = join(base, name), dataDir = join(home, '.zcc'), root = join(home, 'project');
      mkdirSync(dataDir, { recursive: true }); mkdirSync(root);
      const binary = join(home, 'claude'), marker = join(home, 'cli-was-launched');
      writeFileSync(binary, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected CLI launch');\n`, { mode: 0o700 });
      writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ version: 1, shell: '/bin/sh', harnesses: { byId: { claude: { binary } } } }));
      const enrollment = await fetch(`${server.url}api/v1/hosts/join-codes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(response => response.json()) as { joinCode: string; hostId: string };
      const child = spawn(process.execPath, [join(unpack, 'join.mjs'), 'join', '--join-code', enrollment.joinCode, '--host-id', enrollment.hostId,
        '--server-url', server.url.replace(/\/$/, ''), '--host-daemon-port', String(await freePort())], {
        cwd: home, detached: true, env: { ...process.env, HOME: home, ZCC_DATA_DIR: dataDir }, stdio: ['ignore', 'ignore', 'pipe']
      }); children.push(child);
      let stderr = ''; child.stderr!.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
      await vi.waitFor(() => server.ctx.hostHub.ensureHostSessionReady(enrollment.hostId), { timeout: 20_000, interval: 50 });
      const project = await server.ctx.projects.add(root, { hostId: enrollment.hostId });
      const grant = { projectId: project.id, sessionId: randomUUID(), credential: 'a'.repeat(64) };
      const call = (command: Parameters<typeof server.ctx.hostHub.callHostOnlineRpc>[0]['command']) => server.ctx.hostHub.callHostOnlineRpc({ hostId: enrollment.hostId, command });
      await expect(call({ type: 'terminal.start_cli', grant, root, cols: 93, rows: 31, profile: 'claude', config: {} }))
        .rejects.toThrow('CLI Agents are unavailable on this host');
      expect(existsSync(marker)).toBe(false);
      expect(server.ctx.terminalSessions.has(grant.sessionId)).toBe(false);
      const sessionId = randomUUID();
      server.ctx.terminalSessions.set(sessionId, { id: sessionId, projectId: project.id, hostId: enrollment.hostId,
        daemonInstanceId: server.ctx.hostHub.getSession(enrollment.hostId)!.instanceId,
        title: 'Remote shell fixture', profile: 'shell', status: 'running', cwd: root, createdAt: Date.now() });
      expect(await call({ type: 'terminal.start', sessionId, root, cols: 93, rows: 31,
        command: 'test -t 0 && printf "SHELL_READY\\n"; read marker; printf "SHELL_DONE\\n"' }), stderr)
        .toMatchObject({ sessionId, started: true });
      await vi.waitFor(() => expect(server.ctx.terminalSessions.get(sessionId)?.outputText, stderr).toContain('SHELL_READY'), { timeout: 15_000 });
      await call({ type: 'terminal.resize', sessionId, cols: 110, rows: 35 });
      await call({ type: 'terminal.input', sessionId, data: 'finish\r' });
      await vi.waitFor(() => expect(server.ctx.terminalSessions.get(sessionId)?.status, stderr).toBe('exited'), { timeout: 15_000 });
      expect(server.ctx.terminalSessions.get(sessionId)?.exitCode).toBe(0);
      expect(server.ctx.terminalSessions.get(sessionId)?.outputText).toContain('SHELL_DONE');
      await call({ type: 'terminal.stop', sessionId });
      expect(existsSync(marker)).toBe(false);
    }
  } finally {
    await Promise.all(children.map(stop)); await server.close(); rmSync(base, { recursive: true, force: true });
  }
}, 90_000);
