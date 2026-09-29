import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { GitCommit } from '@zana-ai/zcc-domain/product';
import { runGit } from './git.js';
import { WorkspaceError } from './error.js';

export function parseCheckoutHistory(output: string): GitCommit[] {
  const rows: GitCommit[] = [];
  for (const record of output.split('\0')) {
    const [hash, shortHash, author, rawTime, ...subject] = record.trim().split('\x1f');
    const seconds = Number(rawTime);
    if (!/^[a-f0-9]{40,64}$/.test(hash ?? '') || !shortHash || !Number.isSafeInteger(seconds) || !rawTime || !subject.length) continue;
    rows.push({ hash, shortHash, author, ts: seconds * 1000, subject: subject.join('\x1f').trim() });
  }
  return rows;
}

/** Read-only bounded history on the executing host. Do not walk up to a parent
 * repository outside the registered root or follow a replaced root symlink. */
export async function readCheckoutHistory(root: string, limit: number): Promise<GitCommit[]> {
  if (!isAbsolute(root) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new WorkspaceError('invalid_path', 'Invalid checkout history request');
  // Registered legacy paths can contain system aliases such as macOS /var.
  // Match the other host filesystem operations: reject a symlink at the root
  // itself, then canonicalize its parents before comparing repository scope.
  if (!(await lstat(root)).isDirectory()) throw new WorkspaceError('invalid_path', 'Checkout root changed');
  const base = await realpath(root);
  const top = await runGit(base, ['rev-parse', '--show-toplevel'], { maxBuffer: 4096, timeoutMs: 5_000, allowFail: true });
  if (top.code !== 0) return [];
  if (await realpath(top.stdout.trim()) !== base) throw new WorkspaceError('invalid_path', 'Repository is outside the registered checkout');
  const head = await runGit(base, ['rev-parse', '--verify', 'HEAD'], { maxBuffer: 4096, timeoutMs: 5_000, allowFail: true });
  if (head.code !== 0) return [];
  const result = await runGit(base, ['log', `--max-count=${limit}`, '--pretty=format:%H%x1f%h%x1f%an%x1f%at%x1f%s%x00', '--'], {
    maxBuffer: 4 * 1024 * 1024, timeoutMs: 5_000,
  });
  return parseCheckoutHistory(result.stdout);
}
