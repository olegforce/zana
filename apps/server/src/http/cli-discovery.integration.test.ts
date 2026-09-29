import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { expect, it, vi } from 'vitest';
import { resolveHostArtifact } from '../services/hosts/host-artifact.js';
import { discoverProjectCli } from '../services/launch/cli-discovery.js';
import { startProductServer } from './product-server.js';

async function freePort() {
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  return port;
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || !child.pid) return;
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
  const kill = (signal: NodeJS.Signals) => { try { process.kill(-child.pid!, signal); } catch {} };
  kill('SIGTERM'); const timer = setTimeout(() => kill('SIGKILL'), 2000);
  await exited; clearTimeout(timer);
}

it('discovers CLI versions, roles and complete model output on each actual packed daemon with its own HOME/config/cwd', async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'zcc-cli-machines-')));
  const children: ChildProcess[] = [];
  const server = await startProductServer({ dataDir: join(base, 'owner'), origins: { serverPort: 0, devAppPort: 5173 } });
  try {
    const artifact = await resolveHostArtifact({ ...process.env, ZCC_HOST_ARTIFACT: '' });
    const unpack = join(base, 'unpack'); mkdirSync(unpack);
    expect(spawnSync('tar', ['-xzf', artifact.tarballPath, '-C', unpack]).status).toBe(0);
    for (const name of ['first', 'second']) {
      const home = join(base, name), dataDir = join(home, '.zcc'), root = join(home, 'project');
      mkdirSync(dataDir, { recursive: true }); mkdirSync(root);
      const binary = join(home, 'opencode'), audit = join(home, 'audit.jsonl');
      writeFileSync(binary, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(audit)}, JSON.stringify({ args, home: process.env.HOME, cwd: process.cwd() }) + '\\n');
if (args.includes('--version')) process.stdout.write('opencode 1.18.10\\n');
else if (args[0] === 'agent') process.stdout.write('${name}-reviewer (primary)\\nhelper (subagent)\\n');
else if (args[0] === 'debug') process.stdout.write(JSON.stringify({ name: args[2], permission: { read: true }, tools: { bash: true } }));
else if (args[0] === 'models') process.stdout.write(Array.from({ length: 1800 }, (_, i) => '${name}/model-' + i).join('\\n') + '\\n');
else process.exitCode = 2;
`, { mode: 0o700 });
      writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ version: 1, theme: 'dark', opencodeBinary: '/obsolete/legacy', harnesses: { byId: { opencode: { binary } } } }));
      const grant = await fetch(`${server.url}api/v1/hosts/join-codes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(response => response.json()) as { joinCode: string; hostId: string };
      const child = spawn(process.execPath, [join(unpack, 'join.mjs'), 'join', '--join-code', grant.joinCode, '--host-id', grant.hostId,
        '--server-url', server.url.replace(/\/$/, ''), '--host-daemon-port', String(await freePort())], {
        cwd: home, detached: true, env: { ...process.env, HOME: home, ZCC_DATA_DIR: dataDir }, stdio: 'ignore'
      });
      children.push(child);
      await vi.waitFor(() => server.ctx.hostHub.ensureHostSessionReady(grant.hostId), { timeout: 20_000, interval: 50 });
      const project = await server.ctx.projects.add(root, { hostId: grant.hostId });
      const input = { projectId: project.id, hostId: grant.hostId, profile: 'opencode', nativeAgentDiscoveryEnabled: true };
      const query = (query: string, patch: object = {}) => discoverProjectCli(server.ctx, { ...input, query, ...patch }, Date.now() + 20_000);
      expect(await query('version')).toEqual({ query: 'version', version: '1.18.10' });
      const roles = await query('roles');
      expect(roles.query === 'roles' && roles.roles).toContainEqual(expect.objectContaining({ id: `${name}-reviewer` }));
      expect(roles.query === 'roles' && roles.roles.some(role => role.id === 'helper')).toBe(false);
      const models = await query('models');
      expect(models.query === 'models' && models.models?.length).toBe(1800);
      expect(models.query === 'models' && models.models?.at(-1)).toBe(`${name}/model-1799`);
      const rows = readFileSync(audit, 'utf8').trim().split('\n').map(row => JSON.parse(row));
      expect(rows.every(row => row.home === home)).toBe(true);
      expect(rows.filter(row => !row.args.includes('--version')).every(row => row.cwd === root)).toBe(true);
      symlinkSync(base, join(root, 'escape'));
      await expect(query('roles', { cwd: join(root, 'escape') })).rejects.toThrow();
      expect(readFileSync(audit, 'utf8').trim().split('\n')).toHaveLength(rows.length);
      await stop(child);
      await vi.waitFor(() => expect(() => server.ctx.hostHub.ensureHostSessionReady(grant.hostId)).toThrow(), { timeout: 10_000 });
      await expect(query('version')).rejects.toThrow();
    }
  } finally {
    await Promise.all(children.map(stop)); await server.close(); rmSync(base, { recursive: true, force: true });
  }
}, 90_000);
