import { constants, promises as fs, type Stats } from 'node:fs';
import { HostCommandError } from './host-command-error.js';

/** Caller must first confine and stat the canonical path. Bound allocation even
 * when a file grows after that check, and verify the opened inode stayed stable. */
export async function readStableFile(path: string, expected: Stats, maxBytes: number, deadline = Date.now() + 10_000, now = Date.now): Promise<Buffer> {
  const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.dev !== expected.dev || before.ino !== expected.ino) throw new HostCommandError('conflict', 'File changed before reading');
    if (before.size > maxBytes) throw new HostCommandError('too_large', 'File exceeds its read limit');
    const chunks: Buffer[] = [];
    let size = 0;
    while (true) {
      if (now() >= deadline) throw new HostCommandError('timeout', 'File read timed out');
      // The one extra byte detects growth without allowing an oversized allocation.
      const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes - size + 1));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > maxBytes) throw new HostCommandError('too_large', 'File exceeds its read limit');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const after = await file.stat();
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new HostCommandError('conflict', 'File changed while reading');
    return Buffer.concat(chunks, size);
  } finally { await file.close(); }
}
