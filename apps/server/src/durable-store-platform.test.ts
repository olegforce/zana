import { closeSync, existsSync, fsyncSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as store from './durable-store.js';
import * as migration from './services/harness-routing/storage.js';
import * as directorySync from './fsync-directory.js';

const syncDirectory = directorySync.fsyncDirectory;
const roots: string[] = [];
beforeEach(() => {
  vi.spyOn(directorySync, 'fsyncDirectory').mockImplementation((fs, path) => syncDirectory(fs, path, 'win32'));
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'zcc-windows-durability-'));
  roots.push(root);
  const target = join(root, 'config.json');
  const fs: store.DurableWriteFileSystem = {
    readFile: path => readFileSync(path),
    open: vi.fn((path, flags, mode) => {
      if (path === root) throw Object.assign(new Error('directory handle unsupported'), { code: 'EPERM' });
      return openSync(path, flags, mode);
    }),
    writeFile: (fd, bytes) => writeFileSync(fd, bytes),
    fsync: vi.fn(fd => fsyncSync(fd)),
    close: vi.fn(fd => closeSync(fd)),
    rename: vi.fn((from, to) => renameSync(from, to)),
    unlink: path => unlinkSync(path)
  };
  return { root, target, fs };
}

describe.each([['product store', store], ['startup migration', migration]] as const)('%s Windows durability', (_name, api) => {
  it('still flushes file bytes and atomically replaces the target without opening its directory', () => {
    const { target, fs } = fixture();
    api.atomicDurableWrite(target, Buffer.from('before'), { fs, expectedHash: null });
    api.atomicDurableWrite(target, Buffer.from('after'), { fs, expectedHash: api.hashBytes(Buffer.from('before')) });
    expect(readFileSync(target, 'utf8')).toBe('after');
    expect(fs.fsync).toHaveBeenCalledTimes(2);
    expect(fs.rename).toHaveBeenCalledTimes(2);
    expect(fs.close).toHaveBeenCalledTimes(2);
  });

  it('deletes a matching file without opening its directory and still rejects external edits', () => {
    const { target, fs } = fixture();
    writeFileSync(target, 'before');
    expect(() => api.durableRemove(target, { fs, expectedHash: api.hashBytes(Buffer.from('other')) })).toThrow();
    expect(existsSync(target)).toBe(true);
    api.durableRemove(target, { fs, expectedHash: api.hashBytes(Buffer.from('before')) });
    expect(existsSync(target)).toBe(false);
    expect(fs.open).not.toHaveBeenCalled();
  });

  it('propagates a file flush failure, closes the handle, and removes the unfinished temp file', () => {
    const { root, target, fs } = fixture();
    writeFileSync(target, 'before');
    fs.fsync = () => { throw new Error('file flush failed'); };
    expect(() => api.atomicDurableWrite(target, Buffer.from('after'), { fs })).toThrow('file flush failed');
    expect(fs.close).toHaveBeenCalledTimes(1);
    expect(fs.rename).not.toHaveBeenCalled();
    expect(readFileSync(target, 'utf8')).toBe('before');
    expect(readdirSync(root)).toEqual(['config.json']);
  });

  it('keeps access failures visible for reads and compare-and-swap writes', () => {
    const { target, fs } = fixture();
    fs.readFile = () => { throw Object.assign(new Error('access denied'), { code: 'EACCES' }); };
    expect(() => api.readRawFile(target, fs)).toThrow('access denied');
    expect(() => api.atomicDurableWrite(target, Buffer.from('after'), { fs, expectedHash: null })).toThrow('access denied');
    expect(fs.open).not.toHaveBeenCalled();
  });
});
