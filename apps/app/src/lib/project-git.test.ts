import { beforeEach, expect, it, vi } from 'vitest';
import { httpProjectGit, scopedDesktopGit } from './project-git.js';
import { apiJson } from './fetch-with-app-surface.js';
vi.mock('./fetch-with-app-surface.js', () => ({ apiJson: vi.fn() }));
beforeEach(() => { vi.mocked(apiJson).mockReset(); });
const scope = { projectId: 'p', hostId: 'secondary' };
it('carries source and revision for every browser Git operation', async () => {
  vi.mocked(apiJson).mockResolvedValue({ branch: 'main' });
  await httpProjectGit.status('/repo', undefined, scope);
  await httpProjectGit.showHead('/repo/file', scope);
  await httpProjectGit.discard('/repo/file', scope, null);
  expect(await httpProjectGit.isRepo('/repo', scope)).toBe(true);
  await httpProjectGit.listWorktrees('/repo', scope);
  await httpProjectGit.listBranches('/repo', scope);
  expect(vi.mocked(apiJson).mock.calls.map(([, init]) => JSON.parse(init!.body as string).operation)).toEqual(['status', 'head', 'discard', 'status', 'worktrees', 'branches']);
  for (const [, init] of vi.mocked(apiJson).mock.calls) expect(JSON.parse(init!.body as string).scope).toEqual(scope);
  expect(JSON.parse(vi.mocked(apiJson).mock.calls[2]![1]!.body as string).expectedSha256).toBeNull();
});
it('preserves frozen native methods for unscoped calls and never falls back after scoped failure', async () => {
  const owner: any = Object.freeze(Object.fromEntries(['status', 'showHead', 'discard', 'isRepo', 'listWorktrees', 'listBranches'].map(name => [name, vi.fn().mockResolvedValue('native')])));
  const adapter = scopedDesktopGit(owner);
  for (const method of Object.keys(owner)) {
    await (adapter as any)[method]('/repo'); expect(owner[method]).toHaveBeenCalledTimes(1);
  }
  vi.mocked(apiJson).mockRejectedValue(new Error('offline'));
  for (const method of Object.keys(owner)) {
    await expect((adapter as any)[method]('/repo', ...(method === 'status' ? [undefined, scope] : [scope]))).rejects.toThrow('offline');
    expect(owner[method]).toHaveBeenCalledTimes(1);
  }
});
