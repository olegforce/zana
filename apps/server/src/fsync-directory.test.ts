import { describe, expect, it, vi } from 'vitest';
import { fsyncDirectory } from './fsync-directory.js';

function fileSystem() {
  return { open: vi.fn(() => 42), fsync: vi.fn(), close: vi.fn() };
}

describe('directory durability', () => {
  it('avoids unsupported directory handles on Windows', () => {
    const fs = fileSystem();
    fs.open.mockImplementation(() => { throw new Error('EPERM'); });
    fsyncDirectory(fs, 'fixture', 'win32');
    expect(fs.open).not.toHaveBeenCalled();
    expect(fs.fsync).not.toHaveBeenCalled();
    expect(fs.close).not.toHaveBeenCalled();
  });

  it.each(['darwin', 'linux'] as const)('flushes and closes the directory on %s', platform => {
    const fs = fileSystem();
    fsyncDirectory(fs, 'fixture', platform);
    expect(fs.open).toHaveBeenCalledWith('fixture', 'r');
    expect(fs.fsync).toHaveBeenCalledWith(42);
    expect(fs.close).toHaveBeenCalledWith(42);
    expect(fs.fsync.mock.invocationCallOrder[0]).toBeLessThan(fs.close.mock.invocationCallOrder[0]);
  });

  it('defaults to the actual platform', () => {
    const fs = fileSystem();
    fsyncDirectory(fs, 'fixture');
    expect(fs.open).toHaveBeenCalledTimes(process.platform === 'win32' ? 0 : 1);
  });

  it('propagates POSIX open errors without closing an unopened handle', () => {
    const fs = fileSystem();
    fs.open.mockImplementation(() => { throw new Error('EACCES'); });
    expect(() => fsyncDirectory(fs, 'fixture', 'linux')).toThrow('EACCES');
    expect(fs.close).not.toHaveBeenCalled();
  });

  it('closes the handle and propagates a failed POSIX flush', () => {
    const fs = fileSystem();
    fs.fsync.mockImplementation(() => { throw new Error('EIO'); });
    expect(() => fsyncDirectory(fs, 'fixture', 'darwin')).toThrow('EIO');
    expect(fs.close).toHaveBeenCalledWith(42);
  });
});
