import { dirname, isAbsolute, join, relative, sep } from 'node:path';

/**
 * Where an agent-named file may be read as a Squad or execution source. Rule 2's trust
 * anchors decide the location: its realpath must be inside the project, HOME or the clone
 * root. Inside those, secrets are refused wherever they live: credential stores and agent
 * session caches in HOME, the app's own data, and Zana's data folders apart from their
 * document folders (such as the library). One policy for goal-path discovery, Squad
 * proposals, squad_plan_check and the source registry.
 */

/**
 * Credential stores and agent session caches under HOME, relative to it. Kept in step with
 * the extension permission broker's `sensitiveRoots` (a guard test checks it).
 */
export const SENSITIVE_HOME_PATHS: readonly string[] = [
  '.ssh', '.aws', '.gnupg', '.config/gh', '.config/gcloud', '.netrc', '.docker/config.json',
  '.codex', '.cursor', '.claude/sessions'
];

/** Zana's data folders under HOME (production, dev and shared machines); ZCC_DATA_DIR is added by the caller. */
export const ZANA_DATA_DIR_NAMES: readonly string[] = ['.zcc', '.zcc-dev', '.zcc-machines'];

/**
 * The folders of a Zana data folder that may be read: its documents, and the checkouts it
 * manages (Squad worktrees, personal workspaces). Everything else in it (tokens, keys,
 * config, sockets, databases and state folders, including new ones) is refused.
 */
export const READABLE_DATA_DIRS: readonly string[] = ['library', 'personas', 'teams', 'templates', 'saved', 'worktrees', 'personal-workspaces'];

/** How the agent is told what may be attached, so it can correct a refused path itself. */
export const SOURCE_POLICY_TEXT = 'A source must be a file inside this project, your home folder or the clone root. '
  + `Credential stores and agent sessions (${SENSITIVE_HOME_PATHS.map((path) => `~/${path}`).join(', ')}), the app's own data `
  + `and Zana's data folders (~/.zcc and its kin) are refused, except their ${READABLE_DATA_DIRS.join(', ')} folders.`;

export interface SourcePolicy {
  /** Realpaths of the allowed bases: the project, HOME and the clone root. */
  roots: readonly string[];
  /** Realpath of HOME. */
  home: string;
  /** Protected folders and files, plain and realpath'd. Defaults to the credential stores under `home`. */
  protectedRoots?: readonly string[];
  /** Zana data folders, plain and realpath'd. Defaults to `ZANA_DATA_DIR_NAMES` under `home`. */
  dataDirs?: readonly string[];
}

export type SourceRefusal = 'outside' | 'sensitive';

const within = (child: string, parent: string): boolean => {
  const rel = relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};
const atOrWithin = (child: string, parent: string): boolean => child === parent || within(child, parent);

const defaultProtectedRoots = (home: string): string[] => SENSITIVE_HOME_PATHS.map((path) => join(home, path));
const defaultDataDirs = (home: string): string[] => ZANA_DATA_DIR_NAMES.map((name) => join(home, name));

export function isSensitiveSourcePath(real: string, policy: Pick<SourcePolicy, 'home' | 'protectedRoots' | 'dataDirs'>): boolean {
  const protectedRoots = policy.protectedRoots ?? defaultProtectedRoots(policy.home);
  if (protectedRoots.some((root) => atOrWithin(real, root))) return true;
  const dataDirs = policy.dataDirs ?? defaultDataDirs(policy.home);
  return dataDirs.some((dataDir) => atOrWithin(real, dataDir)
    && !READABLE_DATA_DIRS.some((name) => within(real, join(dataDir, name))));
}

/** Why a resolved (realpath) source is refused, or undefined when it may be read. */
export function sourcePathRefusal(real: string, policy: SourcePolicy): SourceRefusal | undefined {
  if (!policy.roots.some((root) => within(real, root))) return 'outside';
  return isSensitiveSourcePath(real, policy) ? 'sensitive' : undefined;
}

/**
 * Resolve a policy. A base that doesn't resolve (a remote project root, an unset clone root)
 * is dropped, as is a clone root that is a filesystem root or contains HOME (it would widen the
 * bases to the whole disk). Protected paths and data folders are kept both as given and
 * realpath'd, so a symlinked `~/.ssh` (a dotfiles setup) stays refused.
 */
export async function resolveSourcePolicy(
  realpath: (path: string) => Promise<string>,
  bases: { projectRoot?: string; home: string; cloneRoot?: string; dataDirs?: readonly string[]; protectedRoots?: readonly string[] }
): Promise<SourcePolicy> {
  const resolveOr = async (path: string | undefined): Promise<string | undefined> => {
    if (!path?.trim()) return undefined;
    try { return await realpath(path); } catch { return undefined; }
  };
  const bothForms = async (paths: readonly string[]): Promise<string[]> =>
    [...new Set((await Promise.all(paths.map(async (path) => [path, await resolveOr(path)]))).flat().filter((path): path is string => !!path))];
  const home = (await resolveOr(bases.home)) ?? bases.home;
  const cloneRoot = await resolveOr(bases.cloneRoot);
  const cloneRootSafe = cloneRoot !== undefined && dirname(cloneRoot) !== cloneRoot && !atOrWithin(home, cloneRoot);
  const roots = [await resolveOr(bases.projectRoot), home, cloneRootSafe ? cloneRoot : undefined].filter((root): root is string => !!root);
  return {
    roots: [...new Set(roots)],
    home,
    protectedRoots: await bothForms([...defaultProtectedRoots(home), ...(bases.protectedRoots ?? [])]),
    dataDirs: await bothForms([...defaultDataDirs(home), ...(bases.dataDirs ?? [])])
  };
}

/** `~`-abbreviated form of an absolute path under HOME, for cards and chips. */
export function displaySourcePath(real: string, home: string): string {
  return within(real, home) ? `~${sep}${relative(home, real)}` : real;
}
