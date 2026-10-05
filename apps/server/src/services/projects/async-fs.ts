import { opendir, open, realpath, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isWithin } from '@zana-ai/zcc-path-confine';
import type { FsEntry, FsReadResult, FsMutateResult } from '@zana-ai/zcc-domain/product';

const DENY = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.turbo', '.DS_Store']);
const READ_LIMIT = 2 * 1024 * 1024;

export async function listDirAsync(path: string): Promise<FsEntry[]> {
  const entries: FsEntry[] = [];
  try {
    const dir = await opendir(path);
    for await (const entry of dir) {
      if (DENY.has(entry.name)) continue;
      const full = join(path, entry.name);
      let kind: 'dir' | 'file' = entry.isDirectory() ? 'dir' : 'file';
      if (entry.isSymbolicLink()) {
        try { kind = (await stat(full)).isDirectory() ? 'dir' : 'file'; } catch { continue; }
      }
      entries.push({ name: entry.name, path: full, kind });
      if (entries.length >= 2000) break;
    }
  } catch { return []; }
  return entries.sort((a, b) => a.kind !== b.kind ? (a.kind === 'dir' ? -1 : 1) : a.name.localeCompare(b.name));
}

export async function readFileAsync(path: string): Promise<FsReadResult> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(path, 'r');
    const info = await file.stat();
    if (!info.isFile()) return { ok: false, message: 'Not a file' };
    const buffer = Buffer.alloc(Math.min(info.size, READ_LIMIT));
    let size = 0;
    while (size < buffer.length) {
      const read = await file.read(buffer, size, buffer.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    const content = buffer.subarray(0, size);
    if (content.subarray(0, 8192).includes(0)) return { ok: true, binary: true, bytes: info.size };
    return { ok: true, content: content.toString('utf8'), bytes: info.size, truncated: info.size > READ_LIMIT, binary: false };
  } catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) }; }
  finally { await file?.close().catch(() => {}); }
}

export async function deletePathAsync(root: string, path: string): Promise<FsMutateResult> {
  try {
    const [base, target] = await Promise.all([realpath(root), realpath(path)]);
    if (!isWithin(target, base)) return { ok: false, message: 'Path is outside the project root' };
    if (target === base) return { ok: false, message: 'Refusing to delete the project root' };
    await rm(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
    return { ok: true, path: target };
  } catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) }; }
}
