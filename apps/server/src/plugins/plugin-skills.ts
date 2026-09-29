import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tryResolveContainedPath } from '@zana-ai/zcc-host-workspace';
export { tryResolveContainedPath, rewritePluginMcpArgs } from '@zana-ai/zcc-host-workspace';

export const SKILLS_PER_PLUGIN_MAX = 20;

/**
 * BB skill discovery: each `skillsRootPaths` entry is a directory of skill
 * folders. A skill is an immediate child directory that contains a regular
 * `SKILL.md` (lstat — a symlinked SKILL.md is ignored). Name = directory name.
 */
export function discoverPluginSkillNames(rootDir: string, skillsRootPaths: string[]): string[] {
  const names = new Set<string>();
  for (const rel of skillsRootPaths) {
    const rootPath = tryResolveContainedPath(rootDir, rel.replace(/\/\*$/, ''));
    if (!rootPath) continue;
    let entries;
    try {
      entries = readdirSync(rootPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const skillFile = lstatSync(join(rootPath, entry.name, 'SKILL.md'));
        if (!skillFile.isFile() || skillFile.isSymbolicLink()) continue;
      } catch {
        continue;
      }
      names.add(entry.name);
      if (names.size >= SKILLS_PER_PLUGIN_MAX) return [...names].sort();
    }
  }
  return [...names].sort();
}
