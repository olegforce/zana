import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, launchApp } from './fixtures/app.js';
import { isolateTmuxEnvironment } from './fixtures/tmux-isolation.js';

test('startup reaps its recorded orphan but preserves another instance on the same tmux server', async ({ home }) => {
  test.skip(process.platform === 'win32', 'tmux is POSIX only');
  const env = isolateTmuxEnvironment(home, process.env);
  const tmux = (...args: string[]) => execFileSync('tmux', args, {
    env, encoding: 'utf8', timeout: 3_000, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  for (const name of ['cc-owned-orphan', 'cc-other-instance']) {
    tmux('-f', '/dev/null', 'new-session', '-d', '-s', name, 'sleep', '120');
  }
  mkdirSync(join(home, 'electron-user-data'), { recursive: true });
  writeFileSync(join(home, 'electron-user-data/restore-capabilities.json'), JSON.stringify({ version: 1, entries: [{
    id: 'e2e-owned-capability', sessionId: 'owned-orphan', createdAt: Date.now(),
    request: { projectId: 'e2e-removed-project', profile: 'shell' },
  }] }));
  const app = await launchApp(home, { initialConfig: { tmuxScope: 'all' } });
  try {
    await expect.poll(() => tmux('list-sessions', '-F', '#{session_name}').split('\n'), { timeout: 25_000 })
      .toEqual(['cc-other-instance']);
  } finally { await app.electron.close(); }
});
