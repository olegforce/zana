import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { readCheckoutHead, discardCheckoutFile } from './git-file.js';
let root: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'zcc-git-file-'))); git('init', '-q');
  writeFileSync(join(root, 'file.txt'), 'original'); git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
it('reads HEAD and restores a changed/deleted file only with its current revision', async () => {
  const path = join(root, 'file.txt'); writeFileSync(path, 'edited');
  expect(await readCheckoutHead(root, path)).toEqual({ ok: true, content: 'original' });
  expect(await discardCheckoutFile(root, path, hash('stale'))).toMatchObject({ ok: false, message: expect.stringContaining('changed') });
  expect(readFileSync(path, 'utf8')).toBe('edited');
  expect(await discardCheckoutFile(root, path, hash('edited'))).toEqual({ ok: true });
  expect(readFileSync(path, 'utf8')).toBe('original');
  rmSync(path); expect(await discardCheckoutFile(root, path, null)).toEqual({ ok: true });
});
it('handles missing and untracked files without removing staged content', async () => {
  const path = join(root, 'new.txt'); expect(await readCheckoutHead(root, path)).toMatchObject({ ok: true, notInHead: true });
  writeFileSync(path, 'new'); git('add', 'new.txt');
  expect(await discardCheckoutFile(root, path, hash('new'))).toMatchObject({ ok: false, message: expect.stringContaining('Unstage') });
  git('reset', '-q', 'HEAD', '--', 'new.txt'); expect(await discardCheckoutFile(root, path, hash('new'))).toEqual({ ok: true });
  expect(existsSync(path)).toBe(false);
  expect(await discardCheckoutFile(root, path, null)).toEqual({ ok: true });
});
it('rejects traversal, Git internals, directories and symlink escape', async () => {
  for (const path of [root, join(root, '../escape'), join(root, '.git/config')]) await expect(readCheckoutHead(root, path)).rejects.toThrow();
  await expect(readCheckoutHead('relative', '/file')).rejects.toThrow('absolute');
  symlinkSync(tmpdir(), join(root, 'escape')); await expect(readCheckoutHead(root, join(root, 'escape/file'))).rejects.toThrow('escapes');
  mkdirSync(join(root, 'dir')); expect(await discardCheckoutFile(root, join(root, 'dir'), null)).toMatchObject({ ok: false });
  expect(await readCheckoutHead(join(root, 'dir'), join(root, 'dir/missing'))).toMatchObject({ notInHead: true });
});
it('bounds HEAD reads, preserves binary detection and handles realistic large output', async () => {
  const large = 'realistic output\n'.repeat(3000);
  writeFileSync(join(root, 'large.txt'), large); writeFileSync(join(root, 'binary.dat'), Buffer.from([0, 1, 2]));
  writeFileSync(join(root, 'huge.txt'), 'x'.repeat(1024 * 1024 + 1));
  git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'more');
  expect(await readCheckoutHead(root, join(root, 'large.txt'))).toEqual({ ok: true, content: large });
  expect(await readCheckoutHead(root, join(root, 'binary.dat'))).toEqual({ ok: true, binary: true });
  expect(await readCheckoutHead(root, join(root, 'huge.txt'))).toMatchObject({ ok: false });
  expect(await discardCheckoutFile(root, join(root, 'huge.txt'), null)).toMatchObject({ ok: false });
});

it('reads and restores only the registered subfolder, with unusual names preserved', async () => {
  const sub = join(root, 'nested'); mkdirSync(sub);
  const path = join(sub, 'quoted "name" -> file.txt'); writeFileSync(path, 'inside');
  git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'sub');
  writeFileSync(path, 'changed');
  expect(await readCheckoutHead(sub, path)).toEqual({ ok: true, content: 'inside' });
  expect(await discardCheckoutFile(sub, path, hash('changed'))).toEqual({ ok: true });
  expect(readFileSync(path, 'utf8')).toBe('inside');
  await expect(readCheckoutHead(sub, join(root, 'file.txt'))).rejects.toThrow('outside');
});

it('never deletes a tracked file via an untracked in-checkout symlink alias', async () => {
  const dir = join(root, 'tracked'); mkdirSync(dir); writeFileSync(join(dir, 'file.txt'), 'protected');
  git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'tracked dir');
  symlinkSync(dir, join(root, 'alias'));
  await expect(discardCheckoutFile(root, join(root, 'alias/file.txt'), hash('protected'))).rejects.toThrow('symbolic links');
  expect(readFileSync(join(dir, 'file.txt'), 'utf8')).toBe('protected');
});
