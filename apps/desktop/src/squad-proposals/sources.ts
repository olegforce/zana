import { constants } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { SquadProposalErrorCode, SquadProposalSource } from '@zana-ai/zcc-domain/squad-proposal';
import {
  SOURCE_POLICY_TEXT,
  displaySourcePath,
  resolveSourcePolicy,
  sourcePathRefusal,
  type SourcePolicy
} from '@zana-ai/zcc-server/services/execution/source-policy';

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

/** Where sources may come from besides the project (HOME, the clone root), and what stays protected in them. */
export interface SquadSourceBases {
  home: string;
  cloneRoot?: string;
  dataDirs?: readonly string[];
  protectedRoots?: readonly string[];
}

/** The project root's realpath plus the policy every source of one proposal is checked against. */
export interface SquadSourceScope {
  projectRoot: string;
  policy: SourcePolicy;
}

type Failure = { ok: false; code: SquadProposalErrorCode; message: string };
/** A confined source and the device and inode its path resolved to when it was checked. */
export interface ConfinedSource { source: SquadProposalSource; identity: { dev: number; ino: number } }
export type Confined = ({ ok: true } & ConfinedSource) | Failure;

const fail = (code: SquadProposalErrorCode, message: string): Failure => ({ ok: false, code, message });

/** `real`'s path relative to `root` when it is strictly inside it, else undefined. */
function insideRoot(root: string, real: string): string | undefined {
  const rel = relative(root, real);
  return rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? undefined : rel;
}

/** The project and the shared source policy, resolved once per check. Undefined when the project folder is gone. */
export async function sourceScope(fs: SquadProposalFs, projectRoot: string, bases: SquadSourceBases): Promise<SquadSourceScope | undefined> {
  let root: string;
  try { root = await fs.realpath(projectRoot); } catch { return undefined; }
  return { projectRoot: root, policy: await resolveSourcePolicy(fs.realpath, { projectRoot: root, ...bases }) };
}

function refusedMessage(rawPath: string, refusal: 'outside' | 'sensitive'): string {
  return refusal === 'sensitive'
    ? `${rawPath} is in a protected location, so it can't be attached. ${SOURCE_POLICY_TEXT}`
    : `${rawPath} is outside this project, your home folder and the clone root, so it can't be attached. ${SOURCE_POLICY_TEXT}`;
}

/**
 * Resolve `rawPath` (relative paths against the project root) and require a regular file the
 * source policy allows. Symlinks are resolved first, so a link can't reach a refused file.
 */
export async function confineSource(fs: SquadProposalFs, scope: SquadSourceScope, rawPath: string): Promise<Confined> {
  const candidate = isAbsolute(rawPath) ? rawPath : resolve(scope.projectRoot, rawPath);
  let real: string;
  try { real = await fs.realpath(candidate); } catch { return fail('SOURCE_NOT_FILE', `${rawPath} does not exist or is not a file.`); }
  const refusal = sourcePathRefusal(real, scope.policy);
  if (refusal) return fail('SOURCE_NOT_ALLOWED', refusedMessage(rawPath, refusal));
  let stat: SquadSourceStat;
  try { stat = await fs.lstat(real); } catch { return fail('SOURCE_NOT_FILE', `${rawPath} does not exist or is not a file.`); }
  if (!stat.isFile()) return fail('SOURCE_NOT_FILE', `${rawPath} is not a regular file.`);
  const rel = insideRoot(scope.projectRoot, real);
  const source: SquadProposalSource = rel === undefined
    ? { path: real, relPath: displaySourcePath(real, scope.policy.home), bytes: stat.size, outsideProject: true }
    : { path: real, relPath: rel, bytes: stat.size };
  return { ok: true, source, identity: { dev: stat.dev, ino: stat.ino } };
}

/**
 * Absolute paths named in a goal are attached as sources at Launch, so they follow the same
 * policy as `sources`. Returns the first existing path it refuses; paths that don't exist are
 * ignored, as Launch ignores them too. Same token rules as the host's goal-source discovery.
 */
export async function goalPathNotAllowed(fs: SquadProposalFs, scope: SquadSourceScope, goal: string): Promise<string | undefined> {
  const raw: string[] = [];
  for (const m of goal.matchAll(/["'`]((?:[A-Za-z]:[/\\]|\/)[^"'`]+)["'`]/g)) if (m[1]) raw.push(m[1]);
  for (const m of goal.matchAll(/(?:^|[\s(])((?:[A-Za-z]:[/\\]|\/)[^\s`'"),;:]+)/g)) if (m[1]) raw.push(m[1]);
  for (const token of raw) {
    const cleaned = token.trim().replace(/^[`'"(]+|[`'"),;:]+$/g, '');
    for (const candidate of cleaned.endsWith('.') ? [cleaned, cleaned.slice(0, -1)] : [cleaned]) {
      let real: string;
      try { real = await fs.realpath(candidate); } catch { continue; }
      if (sourcePathRefusal(real, scope.policy)) return cleaned;
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

const sameFile = (a: { dev: number; ino: number }, b: { dev: number; ino: number }): boolean => a.dev === b.dev && a.ino === b.ino;

/**
 * Read a confined source through one handle, opened without following a final symlink. The
 * handle must be the file (device and inode) recorded when the source was confined, and the
 * path must still resolve to that same file under the policy afterwards. A file or folder
 * swapped in after the check is refused. Node has no openat, so a folder that keeps flipping
 * to a symlink can only be narrowed, not ruled out; the agent could read such a file itself
 * anyway, so this guards what a Squad is handed, not a sandbox.
 */
export async function readConfinedSource(fs: SquadProposalFs, scope: SquadSourceScope, confined: ConfinedSource): Promise<string> {
  const { source, identity } = confined;
  const handle = await fs.open(source.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > FILE_MAX_BYTES) throw new Error('source is not a regular file within the size cap');
    if (!sameFile(opened, identity)) throw new Error('source changed after it was checked');
    const current = await confineSource(fs, scope, source.path);
    if (!current.ok || current.source.path !== source.path || !sameFile(current.identity, opened)) {
      throw new Error('source changed after it was checked');
    }
    return await readBounded(handle, opened.size);
  } finally {
    await handle.close();
  }
}
