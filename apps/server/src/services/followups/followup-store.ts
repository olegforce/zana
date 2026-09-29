import { validateFollowUpFile } from './followup-validation.js';
export { validateFollowUpFile } from './followup-validation.js';
/**
 * On-disk persistence for {@link FollowUp} records — the durable twin of the
 * ephemeral "Needs you" idle badge. A thin, pure FS module (the lifecycle /
 * dedup brain is {@link FollowUpManager}); modelled on `goal-store.ts`:
 *  - one JSON file per record under `~/.zcc/followups` (global) or
 *    `<project>/.zcc/followups` (per-project),
 *  - atomic tmp+rename writes (CLAUDE.md rule 4),
 *  - tolerant validation so a hand-edited / older file still loads with defaults.
 */

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
import type { FollowUp, Project } from '@zana-ai/zcc-domain/product';

import { electronZccDataDir } from '../../electron-data-dir.js';

export const globalDir = () => join(electronZccDataDir(), 'followups');
export const projectDir = (project: Project) => join(project.path, '.zcc', 'followups');

function ensureDir(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function writeJsonAtomic(file: string, value: unknown) {
  const payload = JSON.stringify(value, null, 2);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, payload);
  renameSync(tmp, file);
}

function readFollowUpFile(
  path: string,
  onInvalid?: (path: string, reason: string) => void
): FollowUp | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    onInvalid?.(path, `unreadable JSON: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  const result = validateFollowUpFile(parsed);
  if ('error' in result) {
    onInvalid?.(path, result.error);
    return null;
  }
  return result;
}

function listInDir(
  dir: string,
  source: FollowUp['source'],
  onInvalid?: (path: string, reason: string) => void
): FollowUp[] {
  if (!existsSync(dir)) return [];
  const out: FollowUp[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const f = readFollowUpFile(join(dir, name), onInvalid);
    if (f) {
      f.source = source;
      out.push(f);
    }
  }
  return out;
}

/**
 * Walk the global directory and each project's per-project directory. Follow-ups
 * whose project no longer exists are skipped (kept on disk in case it comes
 * back). `onInvalid` fires once per unreadable / invalid file.
 */
export function listAllFollowUps(
  projects: Project[],
  onInvalid?: (path: string, reason: string) => void
): FollowUp[] {
  const out = listInDir(globalDir(), 'global', onInvalid);
  for (const p of projects) {
    out.push(...listInDir(projectDir(p), { projectId: p.id }, onInvalid));
  }
  return out;
}

function fileFor(followUp: FollowUp, projects: Project[]): string {
  let dir = globalDir();
  const src = followUp.source;
  if (src && src !== 'global') {
    const project = projects.find((x) => x.id === src.projectId);
    if (!project) throw new Error('Project metadata is unavailable on this machine; no local or global fallback is allowed');
    dir = projectDir(project);
  }
  ensureDir(dir);
  return join(dir, `${followUp.id}.json`);
}

export function saveFollowUp(followUp: FollowUp, projects: Project[]): void {
  writeJsonAtomic(fileFor(followUp, projects), stripTransient(followUp));
}

function locateFollowUpFile(id: string, projects: Project[]): string | null {
  const candidates: string[] = [join(globalDir(), `${id}.json`)];
  for (const p of projects) candidates.push(join(projectDir(p), `${id}.json`));
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

export function deleteFollowUp(id: string, projects: Project[]): boolean {
  const path = locateFollowUpFile(id, projects);
  if (!path) return false;
  try {
    rmSync(path);
    return true;
  } catch {
    return false;
  }
}

/** `source` is loader-only metadata; never written to disk. */
function stripTransient(followUp: FollowUp): Omit<FollowUp, 'source'> {
  const { source: _source, ...rest } = followUp;
  void _source;
  return rest;
}
