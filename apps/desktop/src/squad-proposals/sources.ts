import { constants } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { SquadProposalErrorCode, SquadProposalSource } from '@zana-ai/zcc-domain/squad-proposal';

export const FILE_MAX_BYTES = 4 * 1024 * 1024;
export const TOTAL_MAX_BYTES = 16 * 1024 * 1024;

export interface SquadSourceStat {
  isFile(): boolean;
  size: number;
  dev: number;
  ino: number;
}

export interface SquadSourceHandle {
  stat(): Promise<SquadSourceStat>;
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

export interface SquadProposalFs {
  realpath(path: string): Promise<string>;
  lstat(path: string): Promise<SquadSourceStat>;
  /** Read-only open; `flags` carries O_NOFOLLOW so a final symlink is refused. */
  open(path: string, flags: number): Promise<SquadSourceHandle>;
}

type Failure = { ok: false; code: SquadProposalErrorCode; message: string };
export type Confined = { ok: true; source: SquadProposalSource; identity: { dev: number; ino: number } } | Failure;

const fail = (code: SquadProposalErrorCode, message: string): Failure => ({ ok: false, code, message });

/** `real`'s path relative to `root` when it is strictly inside it, else undefined. */
function insideRoot(root: string, real: string): string | undefined {
  const rel = relative(root, real);
  return rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? undefined : rel;
}

/** Resolve `rawPath` against the project root and require a regular file strictly inside it (symlinks resolved). */
export async function confineToProject(fs: SquadProposalFs, projectRoot: string, rawPath: string): Promise<Confined> {
  let root: string;
  try { root = await fs.realpath(projectRoot); } catch { return fail('NOT_FOUND', 'The project folder is not available.'); }
  const candidate = isAbsolute(rawPath) ? rawPath : resolve(projectRoot, rawPath);
  let real: string;
  try { real = await fs.realpath(candidate); } catch { return fail('SOURCE_NOT_FILE', `${rawPath} does not exist or is not a file.`); }
  const rel = insideRoot(root, real);
  if (rel === undefined) return fail('SOURCE_OUTSIDE_PROJECT', `${rawPath} is outside the project. Files must be inside this project.`);
  let stat: SquadSourceStat;
  try { stat = await fs.lstat(real); } catch { return fail('SOURCE_NOT_FILE', `${rawPath} does not exist or is not a file.`); }
  if (!stat.isFile()) return fail('SOURCE_NOT_FILE', `${rawPath} is not a regular file.`);
  return { ok: true, source: { path: real, relPath: rel, bytes: stat.size }, identity: { dev: stat.dev, ino: stat.ino } };
}

/**
 * Absolute paths named in a goal are attached as sources at Launch. A proposal's goal is
 * agent-written, so every existing absolute path it names must resolve inside the project
 * (D3); paths that don't exist are ignored, as Launch ignores them too. Same token rules
 * as the host's goal-source discovery: quoted paths, then unquoted ones.
 */
export async function goalPathOutsideProject(fs: SquadProposalFs, projectRoot: string, goal: string): Promise<string | undefined> {
  const raw: string[] = [];
  for (const m of goal.matchAll(/["'`]((?:[A-Za-z]:[/\\]|\/)[^"'`]+)["'`]/g)) if (m[1]) raw.push(m[1]);
  for (const m of goal.matchAll(/(?:^|[\s(])((?:[A-Za-z]:[/\\]|\/)[^\s`'"),;:]+)/g)) if (m[1]) raw.push(m[1]);
  if (raw.length === 0) return undefined;
  let root: string;
  try { root = await fs.realpath(projectRoot); } catch { return undefined; }
  for (const token of raw) {
    const cleaned = token.trim().replace(/^[`'"(]+|[`'"),;:]+$/g, '');
    for (const candidate of cleaned.endsWith('.') ? [cleaned, cleaned.slice(0, -1)] : [cleaned]) {
      let real: string;
      try { real = await fs.realpath(candidate); } catch { continue; }
      if (insideRoot(root, real) === undefined) return cleaned;
      break;
    }
  }
  return undefined;
}

async function readBounded(handle: SquadSourceHandle, size: number): Promise<string> {
  const buffer = Buffer.alloc(size + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  if (offset > size) throw new Error('source grew while it was read');
  return buffer.subarray(0, offset).toString('utf8');
}

/**
 * Read a confined source through one handle. It is opened without following a final
 * symlink, and must then be the very file (device and inode) its path resolves to inside
 * the project, so a file or folder swapped in after the check is refused, never read.
 */
export async function readConfinedSource(fs: SquadProposalFs, projectRoot: string, source: SquadProposalSource): Promise<string> {
  const handle = await fs.open(source.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > FILE_MAX_BYTES) throw new Error('source is not a regular file within the size cap');
    const current = await confineToProject(fs, projectRoot, source.path);
    if (!current.ok || current.source.path !== source.path || current.identity.dev !== opened.dev || current.identity.ino !== opened.ino) {
      throw new Error('source changed after it was checked');
    }
    return await readBounded(handle, opened.size);
  } finally {
    await handle.close();
  }
}
