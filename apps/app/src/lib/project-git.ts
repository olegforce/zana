import type { CcApi, ProjectFileScope } from '@zana-ai/zcc-desktop-contract';
import { apiJson } from './fetch-with-app-surface.js';
type GitReads = Pick<CcApi['git'], 'status' | 'showHead' | 'discard' | 'isRepo' | 'listWorktrees' | 'listBranches'>;
async function query<T>(operation: string, path: string, scope?: ProjectFileScope, expectedSha256?: string | null): Promise<T> {
  return apiJson<T>('/git', { method: 'POST', body: JSON.stringify({ operation, path, scope, expectedSha256 }) });
}
export const httpProjectGit: GitReads = {
  status: (path, _writeSet, scope) => query('status', path, scope),
  showHead: (path, scope) => query('head', path, scope),
  discard: (path, scope, expected) => query('discard', path, scope, expected),
  isRepo: async (path, scope) => Boolean(await query('status', path, scope)),
  listWorktrees: (path, scope) => query('worktrees', path, scope),
  listBranches: (path, scope) => query('branches', path, scope)
};
export function scopedDesktopGit(desktop: CcApi['git']): CcApi['git'] {
  return {
    ...desktop,
    status: (path, writeSet, scope) => scope ? httpProjectGit.status(path, writeSet, scope) : desktop.status(path, writeSet),
    showHead: (path, scope) => scope ? httpProjectGit.showHead(path, scope) : desktop.showHead(path),
    discard: (path, scope, expected) => scope ? httpProjectGit.discard(path, scope, expected) : desktop.discard(path),
    isRepo: (path, scope) => scope ? httpProjectGit.isRepo(path, scope) : desktop.isRepo(path),
    listWorktrees: (path, scope) => scope ? httpProjectGit.listWorktrees(path, scope) : desktop.listWorktrees(path),
    listBranches: (path, scope) => scope ? httpProjectGit.listBranches(path, scope) : desktop.listBranches(path)
  };
}
