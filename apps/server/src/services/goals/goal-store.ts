import { validateGoalFile } from './goal-validation.js';
export { clampRetain, validateGoalFile } from './goal-validation.js';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import type { Goal, Project } from '@zana-ai/zcc-domain/product';

import { electronZccDataDir } from '../../electron-data-dir.js';

export const globalDir = () => join(electronZccDataDir(), 'goals');
export const projectDir = (project: Project) => join(project.path, '.zcc', 'goals');
function ensureDir(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function writeJsonAtomic(file: string, value: unknown) {
  const payload = JSON.stringify(value, null, 2);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, payload);
  renameSync(tmp, file);
}

function readGoalFile(
  path: string,
  onInvalid?: (path: string, reason: string) => void
): Goal | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    onInvalid?.(path, `unreadable JSON: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  const result = validateGoalFile(parsed);
  if ('error' in result) {
    onInvalid?.(path, result.error);
    return null;
  }
  return result;
}

function listInDir(
  dir: string,
  source: Goal['source'],
  onInvalid?: (path: string, reason: string) => void
): Goal[] {
  if (!existsSync(dir)) return [];
  const out: Goal[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const g = readGoalFile(join(dir, name), onInvalid);
    if (g) {
      g.source = source;
      out.push(g);
    }
  }
  return out;
}

/**
 * Walk the global directory and each project's per-project directory. Goals
 * whose project no longer exists are skipped (kept on disk in case the project
 * comes back). `onInvalid` fires once per unreadable / invalid file.
 */
export function listAllGoals(
  projects: Project[],
  onInvalid?: (path: string, reason: string) => void
): Goal[] {
  const out = listInDir(globalDir(), 'global', onInvalid);
  for (const p of projects) {
    out.push(...listInDir(projectDir(p), { projectId: p.id }, onInvalid));
  }
  return out;
}

function fileFor(goal: Goal, projects: Project[]): string {
  let dir = globalDir();
  const src = goal.source;
  if (src && src !== 'global') {
    const project = projects.find((x) => x.id === src.projectId);
    if (!project) throw new Error('Project metadata is unavailable on this machine; no local or global fallback is allowed');
    dir = projectDir(project);
  }
  ensureDir(dir);
  return join(dir, `${goal.id}.json`);
}

export function saveGoal(goal: Goal, projects: Project[]): void {
  writeJsonAtomic(fileFor(goal, projects), stripTransient(goal));
}

function locateGoalFile(id: string, projects: Project[]): string | null {
  const candidates: string[] = [join(globalDir(), `${id}.json`)];
  for (const p of projects) candidates.push(join(projectDir(p), `${id}.json`));
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

export function deleteGoal(id: string, projects: Project[]): boolean {
  const path = locateGoalFile(id, projects);
  if (!path) return false;
  try {
    rmSync(path);
    return true;
  } catch {
    return false;
  }
}

/** `source` is loader-only metadata; never written to disk. */
function stripTransient(goal: Goal): Omit<Goal, 'source'> {
  const { source: _source, ...rest } = goal;
  void _source;
  return rest;
}
