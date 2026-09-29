export { WorkspaceError } from './error.js';
export {
  provisionWorkspace,
  destroyWorkspace,
  workspaceStatus,
  workspaceDiff,
  workspaceDiffFiles,
  workspaceDiffPatch,
  workspaceCommit,
  workspaceSquashMerge,
  workspaceBranches,
  workspacePullRequest,
  workspacePullRequestAction,
  workspacePullRequestCreate,
  resolveCloneDefaultPath,
  cloneProject,
  resolveAdditionalWorkspaceWriteRoots
} from './workspace.js';
export { resolveAdditionalWorkspaceWriteRootsSync } from './workspace-write-roots.js';
export type { ProvisionInput, UnmanagedCheckout } from './workspace.js';
export { createWorktree, removeWorktree } from './provisioning.js';
export { copyWorktreeIncludeFiles } from './worktree-include.js';
export { runGit, detectGitRepo, discoverWorkspace } from './git.js';
export { withGitRefMutationLock } from './git-ref-mutation-lock.js';

export { readCheckoutHead, discardCheckoutFile } from './git-file.js';
export { readCheckoutHistory } from './git-history.js';

export { withFileMutationLock } from './checkout-mutation-lock.js';

export { tryResolveContainedPath, rewritePluginMcpArgs } from './plugin-paths.js';
