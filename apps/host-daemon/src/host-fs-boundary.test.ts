import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync, existsSync, realpathSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCommandRuntime, dispatchHostCommand } from './command-dispatch.js';
import { HostRpcCommandSchema } from '@zana-ai/zcc-contracts/host-rpc';
import { resolveHostFsRoot } from './host-fs.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'zcc-fs-boundary-'))); roots.push(root);
  const boundary = join(root, '.zcc/library');
  const runtime = createCommandRuntime({ dataDir: root });
  const call = (command: unknown) => dispatchHostCommand(runtime, HostRpcCommandSchema.parse(command));
  const file = (type: string, path: string, more = {}) => call({ type, rootPath: root, boundaryPath: boundary, path, ...more });
  return { root, boundary, call, file };
}
it('creates inside a missing nested boundary and allows confined reads, lists, moves and deletes', async () => {
  const { root, boundary, call, file } = fixture();
  const path = join(boundary, 'notes/a.md');
  expect(await file('host.write_file', path, { content: 'safe', contentEncoding: 'utf8', createParents: true })).toMatchObject({ outcome: 'written' });
  expect(await file('host.read_path', path)).toMatchObject({ content: 'safe' });
  expect(await file('host.file_metadata', path)).toMatchObject({ sizeBytes: 4 });
  expect(await call({ type: 'host.list_dir', root, boundaryPath: boundary, relPath: '.zcc/library/notes' })).toMatchObject({ entries: [{ name: 'a.md' }] });
  await file('host.mkdir', join(boundary, 'other'), { recursive: false });
  await call({ type: 'host.move_path', rootPath: root, boundaryPath: boundary, sourcePath: path, destinationPath: join(boundary, 'other/b.md') });
  await file('host.remove_path', join(boundary, 'other/b.md'), { recursive: false });
  expect(existsSync(join(boundary, 'other/b.md'))).toBe(false);
});
it('rejects symlink escapes even when their targets are inside the registered project', async () => {
  const { root, boundary, call, file } = fixture(); mkdirSync(boundary, { recursive: true });
  const privateDir = join(root, 'private'); mkdirSync(privateDir); writeFileSync(join(privateDir, 'secret.md'), 'private');
  symlinkSync(privateDir, join(boundary, 'escape'));
  const path = join(boundary, 'escape/secret.md');
  for (const command of [
    () => file('host.read_path', path),
    () => file('host.file_metadata', path),
    () => file('host.write_file', path, { content: 'no', contentEncoding: 'utf8', createParents: true }),
    () => file('host.remove_path', path, { recursive: false }),
    () => file('host.mkdir', join(boundary, 'escape/new'), { recursive: true }),
    () => call({ type: 'host.list_dir', root, boundaryPath: boundary, relPath: '.zcc/library/escape' }),
    () => call({ type: 'host.move_path', rootPath: root, boundaryPath: boundary, sourcePath: path, destinationPath: join(boundary, 'stolen.md') })
  ]) await expect(command()).rejects.toThrow(/boundary|root/i);
  expect(readFileSync(join(privateDir, 'secret.md'), 'utf8')).toBe('private'); expect(existsSync(join(privateDir, 'new'))).toBe(false);
});
it('rejects symlink boundary roots and escaped parent roots before creating anything', async () => {
  const { root, boundary, file } = fixture(); const outside = realpathSync(mkdtempSync(join(tmpdir(), 'zcc-outside-'))); roots.push(outside);
  symlinkSync(outside, join(root, '.zcc'));
  await expect(file('host.write_file', join(boundary, 'new.md'), { content: 'no', contentEncoding: 'utf8', createParents: true })).rejects.toThrow('escapes root');
  expect(existsSync(join(outside, 'library'))).toBe(false);
  rmSync(join(root, '.zcc')); mkdirSync(join(root, '.zcc')); mkdirSync(join(root, 'inside'));
  symlinkSync(join(root, 'inside'), boundary);
  await expect(file('host.read_path', join(boundary, 'note.md'))).rejects.toThrow('symbolic link');
});
it('requires an absolute boundary anchored by a real registered root', async () => {
  const { root, boundary } = fixture();
  expect(await resolveHostFsRoot(undefined)).toBeNull(); expect(await resolveHostFsRoot(root)).toBe(root);
  expect(await resolveHostFsRoot(root, boundary)).toBe(boundary);
  await expect(resolveHostFsRoot(undefined, boundary)).rejects.toThrow('authorized root');
  await expect(resolveHostFsRoot(root, 'relative')).rejects.toThrow('absolute');
  await expect(resolveHostFsRoot(root, '/outside')).rejects.toThrow('escapes root');
  writeFileSync(join(root, 'file'), 'text'); await expect(resolveHostFsRoot(root, join(root, 'file'))).rejects.toThrow('not a directory');
});
it('preserves colliding destinations, rejects symlink mutations and bounds existing file reads', async () => {
  const { root, boundary, call, file } = fixture(); mkdirSync(boundary, { recursive: true });
  const a = join(boundary, 'a.md'), b = join(boundary, 'b.md'), link = join(boundary, 'link.md');
  writeFileSync(a, 'source'); writeFileSync(b, 'destination'); symlinkSync(a, link);
  await expect(call({ type: 'host.move_path', rootPath: root, boundaryPath: boundary, sourcePath: a, destinationPath: b })).rejects.toThrow('already exists');
  await expect(call({ type: 'host.move_path', rootPath: root, boundaryPath: boundary, sourcePath: link, destinationPath: join(boundary, 'other.md') })).rejects.toThrow('symbolic link');
  await expect(file('host.remove_path', link, { recursive: false })).rejects.toThrow('symbolic link');
  expect(readFileSync(a, 'utf8')).toBe('source'); expect(readFileSync(b, 'utf8')).toBe('destination');
  truncateSync(a, 25 * 1024 * 1024 + 1);
  await expect(file('host.read_path', a)).rejects.toThrow('exceeds');
  await expect(file('host.write_file', a, { content: 'no', contentEncoding: 'utf8', createParents: false })).rejects.toThrow('write limit');
  await expect(call({ type: 'host.write_file', boundaryPath: boundary, path: b, content: 'no', contentEncoding: 'utf8', createParents: false })).rejects.toThrow('authorized root');
  await expect(call({ type: 'host.write_file', rootPath: join(root, 'missing'), boundaryPath: boundary, path: b, content: 'no', contentEncoding: 'utf8', createParents: false })).rejects.toThrow('does not exist');
});
