import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { listDirAsync, readFileAsync, deletePathAsync } from './async-fs';
import { scanPluginFiles } from '../../plugins/plugin-file-scan';
const dirs: string[] = [];
async function root() { const dir = await mkdtemp(join(tmpdir(), 'async-fs-')); dirs.push(dir); return dir; }
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
it('streams sorted entries, skips denied and broken links, and handles missing paths', async () => {
  const dir = await root(); await mkdir(join(dir, 'folder')); await mkdir(join(dir, 'node_modules')); await writeFile(join(dir, 'a'), 'a'); await symlink(join(dir, 'folder'), join(dir, 'linked')); await symlink(join(dir, 'missing'), join(dir, 'broken'));
  expect((await listDirAsync(dir)).map(e => [e.name, e.kind])).toEqual([['folder', 'dir'], ['linked', 'dir'], ['a', 'file']]);
  expect(await listDirAsync(join(dir, 'missing'))).toEqual([]);
});
it('bounds reads and detects binary and invalid inputs', async () => {
  const dir = await root(); await writeFile(join(dir, 'large'), 'x'.repeat(3 * 1024 * 1024)); await writeFile(join(dir, 'binary'), Buffer.from([0, 1]));
  expect(await readFileAsync(join(dir, 'large'))).toMatchObject({ ok: true, truncated: true, bytes: 3 * 1024 * 1024 });
  expect(await readFileAsync(join(dir, 'binary'))).toMatchObject({ ok: true, binary: true });
  expect(await readFileAsync(dir)).toMatchObject({ ok: false }); expect(await readFileAsync(join(dir, 'missing'))).toMatchObject({ ok: false });
});
it('refuses roots and escaping symlinks and yields during recursive deletion', async () => {
  const dir = await root(), outside = await root(), child = join(dir, 'child'); await mkdir(child); await symlink(outside, join(dir, 'escape'));
  expect(await deletePathAsync(dir, dir)).toMatchObject({ ok: false }); expect(await deletePathAsync(dir, join(dir, 'escape'))).toMatchObject({ ok: false });
  await Promise.all(Array.from({ length: 300 }, (_, i) => writeFile(join(child, String(i)), 'x'))); let ticks = 0; const timer = setInterval(() => ticks++, 1);
  try { expect(await deletePathAsync(dir, child)).toMatchObject({ ok: true }); expect(ticks).toBeGreaterThan(0); } finally { clearInterval(timer); }
  expect(await deletePathAsync(dir, child)).toMatchObject({ ok: false });
});
it('plugin scans skip dependencies, break cycles, and reject excessive or escaping trees', async () => {
  const dir = await root(); await mkdir(join(dir, 'src')); await mkdir(join(dir, '.git')); await writeFile(join(dir, 'src', 'a.ts'), 'x'); await symlink(dir, join(dir, 'src', 'cycle'));
  expect(await scanPluginFiles(dir)).toEqual(['src/a.ts']); await expect(scanPluginFiles(dir, 1)).rejects.toThrow('entry limit');
  await symlink(await root(), join(dir, 'escape')); await expect(scanPluginFiles(dir)).rejects.toThrow('escapes');
});
it('caps directory replies at 2000 entries', async () => {
  const dir = await root(); for (let i = 0; i < 2100; i++) await writeFile(join(dir, String(i)), ''); expect(await listDirAsync(dir)).toHaveLength(2000);
});
