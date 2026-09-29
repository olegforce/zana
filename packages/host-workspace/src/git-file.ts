// HEAD blob lookup adapted from BB readGitBlob/readFileFromGitRef (MIT;
// see docs/third-party/BB-LICENSE). Uses Zana's bounded Git process runner.
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { isWithin } from '@zana-ai/zcc-path-confine';
import type { GitShowResult } from '@zana-ai/zcc-domain/product';
import { runGit } from './git.js';
import { WorkspaceError } from './error.js';
import { withCheckoutMutationLock, withFileMutationLock } from './checkout-mutation-lock.js';

const MAX_BYTES = 1024 * 1024;
async function confined(root: string, path: string) {
  if (!isAbsolute(root) || !isAbsolute(path)) throw new WorkspaceError('invalid_path', 'Choose an absolute checkout path');
  const base = await realpath(root), lexical = resolve(path);
  if (lexical === base || !isWithin(lexical, base) || relative(base, lexical).split('/').includes('.git')) throw new WorkspaceError('invalid_path', 'File is outside the checkout');
  // Deleted tracked files are valid. Their nearest existing parent must still
  // be inside this root; symlink escapes are rejected before Git is invoked.
  let probe = lexical;
  for (;;) {
    try {
      const physical = await realpath(probe);
      if (!isWithin(physical, base)) throw new WorkspaceError('invalid_path', 'File escapes the checkout');
      if (physical !== probe) throw new WorkspaceError('invalid_path', 'Git file operations cannot follow symbolic links');
      break;
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; const parent = dirname(probe); if (parent === probe) throw error; probe = parent; }
  }
  const top = await runGit(base, ['rev-parse', '--show-toplevel'], { maxBuffer: 4096 });
  const repoRoot = await realpath(top.stdout.trim());
  return { base, path: lexical, relativePath: relative(base, lexical).split('\\').join('/'), headPath: relative(repoRoot, lexical).split('\\').join('/') };
}
async function readHead(base: string, relativePath: string): Promise<GitShowResult> {
  const target = `HEAD:${relativePath}`;
  const size = await runGit(base, ['cat-file', '-s', target], { maxBuffer: 4096, allowFail: true });
  if (size.code !== 0) return { ok: true, notInHead: true, content: '' };
  const count = Number(size.stdout.trim());
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_BYTES) return { ok: false, message: 'HEAD file exceeds the read limit' };
  const blob = await runGit(base, ['cat-file', 'blob', target], { maxBuffer: MAX_BYTES });
  return blob.stdout.includes('\0') ? { ok: true, binary: true } : { ok: true, content: blob.stdout };
}
export async function readCheckoutHead(root: string, path: string): Promise<GitShowResult> {
  const file = await confined(root, path);
  return readHead(file.base, file.headPath);
}
export async function discardCheckoutFile(root: string, path: string, expectedSha256: string | null): Promise<{ ok: boolean; message?: string }> {
  const file = await confined(root, path);
  return withCheckoutMutationLock(file.base, () => withFileMutationLock(file.path, async () => {
    let digest: string | null = null;
    try {
      const info = await lstat(file.path);
      if (!info.isFile() || info.size > MAX_BYTES) return { ok: false, message: 'Discard requires a regular file within the size limit' };
      digest = createHash('sha256').update(await readFile(file.path)).digest('hex');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (digest !== expectedSha256) return { ok: false, message: 'The file changed. Refresh it before discarding.' };
    const head = await readHead(file.base, file.headPath);
    if (!head.ok) return head;
    if (head.notInHead) {
      // Untracked files may be removed, but never a newly staged file (which
      // needs an explicit index operation outside this single-file action).
      const indexed = await runGit(file.base, ['--literal-pathspecs', 'ls-files', '--error-unmatch', '--', file.relativePath], { maxBuffer: 4096, allowFail: true });
      if (indexed.code === 0) return { ok: false, message: 'Unstage this new file before discarding it' };
      if (digest !== null) await unlink(file.path);
    } else {
      await runGit(file.base, ['--literal-pathspecs', 'restore', '--source=HEAD', '--worktree', '--', file.relativePath]);
    }
    return { ok: true };
  }));
}
