import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { test, expect } from './fixtures/app.js';
import { startGitDaemon, type GitDaemon } from './fixtures/git-daemon.js';

test('Import from Git clones locally when two machines are connected', async ({ app, home }) => {
  const win = app.window;
  const origin = new URL(win.url()).origin;
  const hosts = () => win.evaluate(async () => (await fetch('/api/v1/hosts')).json());
  let child: ChildProcess | undefined;
  let git: GitDaemon | undefined;
  let stderr = '';
  try {
    await expect.poll(async () => (await hosts()).some((host: any) => host.isPrimary && host.status === 'connected')).toBe(true);
    // Pair a real second daemon using the app's shipped artifact and its own
    // HOME. No mocked renderer requests or host-routing seams.
    const grant = await win.evaluate(async () => (await fetch('/api/v1/hosts/join-codes', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
    })).json());
    const artifact = await fetch(`${origin}/install/zcc-host.tgz`);
    expect(artifact.status).toBe(200);
    const archive = join(home, 'daemon.tgz');
    writeFileSync(archive, Buffer.from(await artifact.arrayBuffer()), { mode: 0o600 });
    const unpack = join(home, 'packed-daemon');
    mkdirSync(unpack);
    expect(spawnSync('tar', ['-xzf', archive, '-C', unpack]).status).toBe(0);
    const socket = createServer();
    await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve));
    const port = (socket.address() as { port: number }).port;
    await new Promise<void>(resolve => socket.close(() => resolve()));
    const remoteHome = join(home, 'remote-machine');
    mkdirSync(remoteHome);
    child = spawn(process.execPath, [join(unpack, 'join.mjs'), 'join', '--join-code', grant.joinCode,
      '--host-id', grant.hostId, '--server-url', origin, '--host-daemon-port', String(port)], {
      detached: true, stdio: ['ignore', 'ignore', 'pipe'], cwd: remoteHome,
      env: { PATH: process.env.PATH, HOME: remoteHome, ZCC_DATA_DIR: join(remoteHome, '.zcc'), SHELL: '/bin/sh' }
    });
    child.stderr!.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-16_384); });
    await expect.poll(async () => (await hosts()).filter((host: any) => host.status === 'connected').length,
      { timeout: 30_000 }).toBe(2);
    expect(child.exitCode, stderr).toBeNull();

    git = await startGitDaemon(join(home, 'git-server'), [{ repoName: 'import-regression',
      files: { 'README.md': 'Cloned on the primary machine.\n' } }]);
    await win.getByRole('button', { name: 'Add project', exact: true }).click();
    await win.getByRole('button', { name: 'Clone from Git', exact: true }).click();
    const dialog = win.getByRole('dialog', { name: 'Import from Git', exact: true });
    await dialog.getByRole('textbox', { name: 'Repository URL' }).fill(git.urlFor('import-regression'));
    const destination = join(home, 'zcc-workspace', 'import-regression');
    await expect(dialog.locator('.git-dest-preview')).toContainText(destination);
    await dialog.getByRole('button', { name: 'Clone & add', exact: true }).click();
    await expect(dialog).toHaveCount(0, { timeout: 30_000 });
    const { projects } = await win.evaluate(async () => (await fetch('/api/v1/projects')).json());
    const imported = projects.find((project: any) => project.name === 'import-regression');
    expect(imported).toMatchObject({ path: realpathSync(destination) });
    expect(imported.hostId).toBeUndefined();
    expect(readFileSync(join(destination, 'README.md'), 'utf8')).toBe('Cloned on the primary machine.\n');
    expect(existsSync(join(remoteHome, 'zcc-workspace', 'import-regression'))).toBe(false);

    // The same flow still gives the actionable destination-exists hint.
    await win.getByRole('button', { name: 'Add project', exact: true }).click();
    await win.getByRole('button', { name: 'Clone from Git', exact: true }).click();
    await dialog.getByRole('textbox', { name: 'Repository URL' }).fill(git.urlFor('import-regression'));
    await dialog.getByRole('button', { name: 'Clone & add', exact: true }).click();
    await expect(dialog.locator('.modal-error')).toContainText('Rename the project or remove that folder');
    expect(readFileSync(join(destination, 'README.md'), 'utf8')).toBe('Cloned on the primary machine.\n');
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => child!.once('close', () => resolve()));
      try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
      const timer = setTimeout(() => { try { process.kill(-child!.pid!, 'SIGKILL'); } catch {} }, 2000);
      await exited;
      clearTimeout(timer);
    }
    await git?.close();
  }
});
