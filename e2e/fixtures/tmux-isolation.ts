import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// A HOME alone does not isolate tmux: its default server lives under TMPDIR.
// Keep paths short enough for macOS Unix sockets and retain one server per
// fixture home across app restarts. Only directories created here are cleaned.
const roots = new Map<string, string>();

export function isolateTmuxEnvironment(home: string, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const key = resolve(home);
  let root = roots.get(key);
  if (!root) {
    root = mkdtempSync(join(tmpdir(), 'zcc-tmux-'));
    roots.set(key, root);
  }
  const env = { ...inherited, TMUX_TMPDIR: root };
  // An inherited TMUX socket takes precedence over TMUX_TMPDIR.
  delete env.TMUX;
  delete env.TMUX_PANE;
  return env;
}

export async function cleanupTmuxEnvironment(home: string): Promise<void> {
  const key = resolve(home);
  const root = roots.get(key);
  if (!root) return;
  roots.delete(key);
  if (process.platform !== 'win32') {
    // Explicit socket: never fall back to the user's default server, including
    // when a fixture failed before starting its private server.
    const socket = join(root, `tmux-${process.getuid!()}`, 'default');
    await new Promise<void>((done) => execFile('tmux', ['-S', socket, 'kill-server'],
      { timeout: 3_000, maxBuffer: 16 * 1024 }, () => done()));
  }
  rmSync(root, { recursive: true, force: true });
}
