interface DirectoryFileSystem {
  open(path: string, flags: string): number;
  fsync(fd: number): void;
  close(fd: number): void;
}

/** Flush directory metadata where Node supports it. File data is flushed separately. */
export function fsyncDirectory(
  fs: DirectoryFileSystem,
  path: string,
  platform: NodeJS.Platform = process.platform
): void {
  // Windows cannot flush a directory handle through Node's fsync. Attempting
  // it makes an already-renamed write fail and blocks every startup migration.
  if (platform === 'win32') return;
  const fd = fs.open(path, 'r');
  try {
    fs.fsync(fd);
  } finally {
    fs.close(fd);
  }
}
