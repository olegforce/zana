import { randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Stable product identity, independent of a daemon's per-connection instanceId. */
export function readProductInstanceId(dataDir: string): string {
  const file = join(dataDir, 'product-instance.json');
  const read = (): string => {
    if (statSync(file).size > 1024) throw new Error('Invalid product instance identity');
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.id)) throw new Error('Invalid product instance identity');
    return value.id;
  };
  try { return read(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ id: randomUUID() }) + '\n', { flag: 'wx', mode: 0o600 });
    // Publish a complete file without overwriting another process's winner.
    try { linkSync(temporary, file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  } finally { rmSync(temporary, { force: true }); }
  return read();
}
