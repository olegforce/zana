import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { promises as fs, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, truncateSync, rmSync, renameSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshotHostPath } from './host-tree-snapshot.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const rootPath = mkdtempSync(join(tmpdir(), 'tree-snapshot-')); roots.push(rootPath);
  const boundaryPath = join(rootPath, 'library'); mkdirSync(boundaryPath);
  const path = join(boundaryPath, 'tree'); mkdirSync(path);
  return { rootPath, boundaryPath, path };
}
it('snapshots all binary/hidden/empty descendants with content hashes and includes an empty file', async () => {
  const command = fixture(); mkdirSync(join(command.path, 'empty')); writeFileSync(join(command.path, '.hidden'), Buffer.from([0, 255])); writeFileSync(join(command.path, 'zero'), '');
  expect((await snapshotHostPath(command)).entries).toEqual([
    { kind: 'dir', relPath: '' },
    { kind: 'file', relPath: '.hidden', sizeBytes: 2, sha256: createHash('sha256').update(Buffer.from([0, 255])).digest('hex') },
    { kind: 'dir', relPath: 'empty' },
    { kind: 'file', relPath: 'zero', sizeBytes: 0, sha256: createHash('sha256').update('').digest('hex') }
  ]);
  expect((await snapshotHostPath({ ...command, path: join(command.path, 'zero') })).entries).toHaveLength(1);
  expect(await snapshotHostPath({ ...command, path: join(command.path, 'missing') })).toEqual({ entries: null });
});
it('rejects root operations, traversal, a relative path and symlinks including ones inside the boundary', async () => {
  const command = fixture(); writeFileSync(join(command.path, 'file'), 'private');
  for (const path of [command.boundaryPath, command.rootPath, 'relative']) await expect(snapshotHostPath({ ...command, path })).rejects.toThrow();
  symlinkSync(join(command.path, 'file'), join(command.boundaryPath, 'link'));
  await expect(snapshotHostPath({ ...command, path: join(command.boundaryPath, 'link') })).rejects.toThrow('symbolic');
  symlinkSync(join(command.path, 'file'), join(command.path, 'inner-link'));
  await expect(snapshotHostPath(command)).rejects.toThrow('symbolic');
  rmSync(join(command.path, 'inner-link')); symlinkSync(command.rootPath, join(command.path, 'escape'));
  await expect(snapshotHostPath(command)).rejects.toThrow('symbolic');
  await expect(snapshotHostPath(command, Date.now() - 1)).rejects.toThrow('timed out');
});
it('bounds the entry count, depth, single-file and cumulative byte size', async () => {
  const command = fixture();
  for (let i = 0; i < 1000; i++) writeFileSync(join(command.path, `f${i}`), '');
  await expect(snapshotHostPath(command)).rejects.toThrow('entry');
  rmSync(command.path, { recursive: true }); mkdirSync(join(command.path, ...Array(33).fill('deep')), { recursive: true });
  await expect(snapshotHostPath(command)).rejects.toThrow('depth');
  rmSync(command.path, { recursive: true }); mkdirSync(command.path);
  writeFileSync(join(command.path, 'large'), ''); truncateSync(join(command.path, 'large'), 25 * 1024 * 1024 + 1);
  await expect(snapshotHostPath(command)).rejects.toThrow('byte limit');
  truncateSync(join(command.path, 'large'), 24 * 1024 * 1024);
  for (const name of ['two', 'three']) { writeFileSync(join(command.path, name), ''); truncateSync(join(command.path, name), 24 * 1024 * 1024); }
  await expect(snapshotHostPath(command)).rejects.toThrow('byte limit');
});
it('rejects special files without attempting to open them', async () => {
  const command = fixture(), server = createServer();
  // Unix sockets need a short pathname on macOS.
  const short = join('/tmp', `zcc-tree-${process.pid}-${Date.now()}.sock`);
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(short, resolve); });
    renameSync(short, join(command.path, 'socket'));
    await expect(snapshotHostPath(command)).rejects.toThrow('unsupported');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(short, { force: true }); }
});
it('detects inode replacement, growth, and a deadline reached after opening without leaking the handle', async () => {
  for (const change of ['replace', 'grow', 'timeout'] as const) {
    const command = fixture(), file = join(command.path, 'file'); writeFileSync(file, 'Original');
    const open = fs.open.bind(fs); let close: ReturnType<typeof vi.spyOn> | undefined;
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (change === 'replace') { renameSync(file, file + '.old'); writeFileSync(file, 'Replacement'); }
      if (change === 'grow') truncateSync(file, 26 * 1024 * 1024);
      const handle = await open(...args); close = vi.spyOn(handle, 'close');
      if (change === 'timeout') vi.spyOn(Date, 'now').mockReturnValue(10 ** 15);
      return handle;
    });
    await expect(snapshotHostPath({ ...command, path: file })).rejects.toThrow(/changed|byte limit|timed out/);
    expect(close).toHaveBeenCalledOnce(); vi.restoreAllMocks();
  }
});
