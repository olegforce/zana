import { mkdtempSync, writeFileSync, rmSync, promises as fs, type Stats, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { readStableFile } from './read-stable-file.js';

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
it.each([0, 1, 128 * 1024 + 13])('reads a stable %i-byte file including chunk boundaries without truncation', async size => {
  const dir = mkdtempSync(join(tmpdir(), 'zcc-stable-read-')); dirs.push(dir);
  const path = join(dir, 'binary'), bytes = Buffer.alloc(size, 0xfe); writeFileSync(path, bytes);
  const stat = await fs.stat(path);
  expect(await readStableFile(path, stat, size)).toEqual(bytes);
});
it.skipIf(process.platform === 'win32')('does not block when a regular file is replaced by a FIFO before open', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zcc-stable-fifo-')); dirs.push(dir);
  const path = join(dir, 'file'); writeFileSync(path, 'old'); const stat = await fs.stat(path);
  rmSync(path); expect(spawnSync('mkfifo', [path]).status).toBe(0);
  await expect(readStableFile(path, stat, 10)).rejects.toMatchObject({ code: 'conflict' });
});
function mockFile() {
  const before = { dev: 1, ino: 2, size: 3, mtimeMs: 4, ctimeMs: 5, isFile: () => true } as Stats;
  const handle = { stat: vi.fn().mockResolvedValue(before), read: vi.fn().mockResolvedValueOnce({ bytesRead: 3 }).mockResolvedValue({ bytesRead: 0 }), close: vi.fn() };
  const open = vi.spyOn(fs, 'open').mockResolvedValue(handle as unknown as Awaited<ReturnType<typeof fs.open>>);
  return { before, handle, open };
}
it.each(['type', 'dev', 'ino', 'size'])('rejects a changed %s before reading and releases the opened handle', async kind => {
  const { before, handle, open } = mockFile();
  handle.stat.mockResolvedValue({ ...before, ...(kind === 'type' ? { isFile: () => false } : { [kind]: before[kind as 'dev' | 'ino' | 'size'] + 1 }) });
  await expect(readStableFile('/resolved', before, 3)).rejects.toMatchObject({ code: kind === 'size' ? 'too_large' : 'conflict' });
  expect(handle.read).not.toHaveBeenCalled(); expect(handle.close).toHaveBeenCalledOnce();
  expect(open).toHaveBeenCalledWith('/resolved', constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
});
it.each(['read-size', 'size', 'mtimeMs', 'ctimeMs'])('rejects inconsistent %s after reading', async kind => {
  const { before, handle } = mockFile();
  if (kind === 'read-size') handle.read.mockReset().mockResolvedValue({ bytesRead: 0 });
  else handle.stat.mockResolvedValueOnce(before).mockResolvedValueOnce({ ...before, [kind]: 9 });
  await expect(readStableFile('/resolved', before, 3)).rejects.toMatchObject({ code: 'conflict' });
  expect(handle.close).toHaveBeenCalledOnce();
});
it('bounds growth allocation and closes on read failure and timeout', async () => {
  const { before, handle } = mockFile();
  handle.read.mockReset().mockResolvedValue({ bytesRead: 4 });
  await expect(readStableFile('/resolved', before, 3)).rejects.toMatchObject({ code: 'too_large' });
  expect(handle.read.mock.calls[0][0]).toHaveLength(4); expect(handle.close).toHaveBeenCalledOnce();
  handle.read.mockRejectedValue(new Error('read failed'));
  await expect(readStableFile('/resolved', before, 3)).rejects.toThrow('read failed'); expect(handle.close).toHaveBeenCalledTimes(2);
  await expect(readStableFile('/resolved', before, 3, 10, () => 10)).rejects.toMatchObject({ code: 'timeout' }); expect(handle.close).toHaveBeenCalledTimes(3);
});
it('propagates a rejected open without following a replaced symbolic link', async () => {
  const { before, handle, open } = mockFile(); open.mockRejectedValue(Object.assign(new Error('symlink'), { code: 'ELOOP' }));
  await expect(readStableFile('/resolved', before, 3)).rejects.toMatchObject({ code: 'ELOOP' }); expect(handle.close).not.toHaveBeenCalled();
});
