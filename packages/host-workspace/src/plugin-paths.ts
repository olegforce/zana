import { existsSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

/**
 * Resolve a plugin-relative path if it stays inside rootDir. Returns null when
 * the path is missing or escapes (BB: a missing skills root is "no skills").
 */
export function tryResolveContainedPath(rootDir: string, relative: string): string | null {
  if (!relative || relative.includes('\0')) return null;
  try {
    const root = realpathSync(rootDir);
    const candidate = resolve(root, relative);
    if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return null;
    if (!existsSync(candidate)) return null;
    const real = realpathSync(candidate);
    if (real !== root && !real.startsWith(`${root}${sep}`)) return null;
    return real;
  } catch {
    return null;
  }
}

/**
 * Rewrite relative MCP args that exist under the plugin root to contained
 * realpaths. Returns null when any path-looking arg escapes the root (caller
 * must drop that server).
 */
export function rewritePluginMcpArgs(rootDir: string, args: string[] | undefined): string[] | null {
  if (!args) return [];
  const out: string[] = [];
  for (const arg of args) {
    const looksLikePath =
      arg.startsWith('.') ||
      arg.includes('/') ||
      arg.includes('\\');
    if (!looksLikePath || arg.startsWith('-')) {
      out.push(arg);
      continue;
    }
    const resolved = tryResolveContainedPath(rootDir, arg);
    if (!resolved) return null;
    out.push(resolved);
  }
  return out;
}
