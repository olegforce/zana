import { createHash } from 'node:crypto';
import { promises as fs, constants } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { isWithin } from '@zana-ai/zcc-path-confine';
import type { HostSnapshotPathResult, HostTreeEntry } from '@zana-ai/zcc-contracts/host-rpc';
import { resolveHostFsRoot, resolveWriteTarget } from './host-fs.js';
import { HostCommandError } from './host-command-error.js';

/** A complete bounded snapshot, never a silently truncated directory listing.
 * Used before destructive operations; reject links and special files instead of
 * following them, and hash the opened inode with bounded memory and elapsed time.
 */
export async function snapshotHostPath(command: { path: string; rootPath: string; boundaryPath: string }, deadline = Date.now() + 10_000): Promise<HostSnapshotPathResult> {
  if (!isAbsolute(command.path)) throw new HostCommandError('invalid_path', 'Path must be absolute');
  const root = (await resolveHostFsRoot(command.rootPath, command.boundaryPath))!;
  const target = (await resolveWriteTarget(command.path)).writePath;
  if (!isWithin(target, root) || target === root) throw new HostCommandError('invalid_path', 'Tree must be below the authorized boundary');
  // Reject a symlink even when its target is inside the boundary.
  try { if ((await fs.lstat(command.path)).isSymbolicLink()) throw new HostCommandError('invalid_path', 'Tree cannot be a symbolic link'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { entries: null }; throw error; }
  const pending = [target], entries: HostTreeEntry[] = [];
  let totalBytes = 0;
  while (pending.length) {
    if (Date.now() >= deadline) throw new HostCommandError('timeout', 'Tree snapshot timed out');
    const path = pending.pop()!, relPath = relative(target, path).split('\\').join('/');
    if (relPath.split('/').length > 32 || entries.length + pending.length >= 1000) throw new HostCommandError('too_large', 'Tree exceeds its entry or depth limit');
    const stat = await fs.lstat(path);
    if (stat.isSymbolicLink() || !isWithin(await fs.realpath(path), target)) throw new HostCommandError('invalid_path', 'Tree contains a symbolic link');
    if (stat.isDirectory()) {
      entries.push({ kind: 'dir', relPath });
      // opendir avoids allocating an unbounded readdir result.
      const dir = await fs.opendir(path);
      for await (const entry of dir) {
        if (entries.length + pending.length >= 1000) throw new HostCommandError('too_large', 'Tree exceeds its entry limit');
        pending.push(join(path, entry.name));
      }
      continue;
    }
    if (!stat.isFile() || stat.size > 25 * 1024 * 1024 || totalBytes + stat.size > 64 * 1024 * 1024) throw new HostCommandError('too_large', 'Tree contains an unsupported file or exceeds its byte limit');
    const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
    let bytes = 0;
    try {
      const before = await handle.stat();
      if (before.dev !== stat.dev || before.ino !== stat.ino) throw new HostCommandError('conflict', 'Tree changed while reading');
      while (true) {
        if (Date.now() >= deadline) throw new HostCommandError('timeout', 'Tree snapshot timed out');
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        bytes += bytesRead; totalBytes += bytesRead;
        if (bytes > 25 * 1024 * 1024 || totalBytes > 64 * 1024 * 1024) throw new HostCommandError('too_large', 'Tree exceeds its byte limit');
        hash.update(buffer.subarray(0, bytesRead));
      }
      const after = await handle.stat();
      if (bytes !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new HostCommandError('conflict', 'Tree changed while reading');
    } finally { await handle.close(); }
    entries.push({ kind: 'file', relPath, sha256: hash.digest('hex'), sizeBytes: bytes });
  }
  return { entries: entries.sort((a, b) => a.relPath.localeCompare(b.relPath)) };
}
