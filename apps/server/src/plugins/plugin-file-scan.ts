import { opendir, realpath, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { isWithin } from '@zana-ai/zcc-path-confine';

/** Activation must fail closed on excessive trees, without blocking other plugins. */
export async function scanPluginFiles(root: string, maxEntries = 50_000): Promise<string[]> {
  const base = await realpath(root);
  const stack = [{ path: base, depth: 0 }];
  const seen = new Set<string>();
  const files: string[] = [];
  let entries = 0;
  while (stack.length) {
    const next = stack.pop()!;
    if (next.depth > 32) throw new Error('Plugin directory exceeds the depth limit');
    const path = await realpath(next.path);
    if (!isWithin(path, base)) throw new Error('Plugin directory escapes its root');
    if (seen.has(path)) continue;
    seen.add(path);
    const dir = await opendir(path);
    for await (const entry of dir) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      if (++entries > maxEntries) throw new Error('Plugin directory exceeds the entry limit');
      const full = join(path, entry.name);
      const canonical = entry.isSymbolicLink() ? await realpath(full) : full;
      if (!isWithin(canonical, base)) throw new Error('Plugin file escapes its root');
      const directory = entry.isSymbolicLink() ? (await stat(canonical)).isDirectory() : entry.isDirectory();
      if (directory) stack.push({ path: canonical, depth: next.depth + 1 });
      else files.push(relative(base, canonical).split(sep).join('/'));
    }
  }
  return files;
}
