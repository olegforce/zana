// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { GitHostPullRequest, WorkspaceStatus } from '@zana-ai/zcc-domain';
import { EnvironmentActionsView } from '../EnvironmentActions.js';

vi.mock('../../hooks/useCompactLayout.js', () => ({ useCompactLayout: () => true }));
afterEach(cleanup);
const files = Array.from({ length: 210 }, (_, i) => ({ path: `src/file-${i}.ts`, kind: 'modified' }));
function fixture(prState: string | null = 'OPEN', dirty = true, truncated = false) {
  const onAction = vi.fn();
  const status = { branchName: 'main', defaultBranch: 'main', dirty, files: dirty ? files : [], filesTruncated: truncated } as WorkspaceStatus;
  const pr = prState ? { url: 'https://example.test/pr/12', number: 12, state: prState, isDraft: false } as GitHostPullRequest : null;
  const view = render(<EnvironmentActionsView status={status} pr={pr} busy={false} message={null} transcript={[]}
    onCancelProvision={vi.fn()} onAction={onAction} />);
  return { ...view, onAction };
}

it('starts with a compact file count and actions collapsed, while keeping the PR visible', () => {
  const { container, onAction } = fixture();
  const filesDisclosure = screen.getByText('210 changed files').closest('details')!;
  expect(filesDisclosure.open).toBe(false);
  expect(screen.getByRole('link', { name: /PR #12/ })).toBeTruthy();
  expect(container.querySelectorAll('.environment-change')).toHaveLength(12);
  fireEvent.click(filesDisclosure.querySelector('summary')!);
  expect(filesDisclosure.open).toBe(true);
  const actions = screen.getByText('Workspace actions').closest('details')!;
  expect(actions.open).toBe(false);
  fireEvent.click(actions.querySelector('summary')!);
  fireEvent.click(screen.getByRole('button', { name: 'Commit', exact: true }));
  expect(onAction).toHaveBeenCalledWith({ action: 'commit' });
});

it.each(['MERGED', 'CLOSED', 'merged', 'closed'])('keeps %s PRs readable without obsolete merge or draft actions', (state) => {
  const { container } = fixture(state, false);
  expect(screen.getByRole('link', { name: /PR #12/ })).toBeTruthy();
  expect(screen.queryByText('Workspace actions')).toBeNull();
  expect(container.textContent).not.toContain('Merge squash');
  expect(container.textContent).not.toContain('Convert to draft');
});

it('labels a truncated count honestly and retains create-PR when no PR exists', () => {
  fixture(null, true, true);
  expect(screen.getByText('210+ changed files')).toBeTruthy();
  fireEvent.click(screen.getByText('Workspace actions'));
  expect(screen.getByRole('button', { name: 'Open pull request' })).toBeTruthy();
});

it.each([false, true])('retains expanded workspace actions for an open PR (draft=%s)', (isDraft) => {
  const onAction = vi.fn();
  render(<EnvironmentActionsView
    status={{ branchName: 'feature', defaultBranch: 'main', dirty: true, files } as WorkspaceStatus}
    pr={{ url: 'https://example.test/pr/12', number: 12, state: 'OPEN', isDraft } as GitHostPullRequest}
    busy={false} message={null} transcript={[]} onCancelProvision={vi.fn()} onAction={onAction} />);
  fireEvent.click(screen.getByText('Workspace actions'));
  for (const [label, action] of [
    ['Squash into main', { action: 'squash_merge', targetBranch: 'main' }],
    [isDraft ? 'Mark ready' : 'Convert to draft', { action: isDraft ? 'pull_request_ready' : 'pull_request_draft' }],
    ['Merge squash', { action: 'pull_request_merge', method: 'squash' }]
  ] as const) {
    fireEvent.click(screen.getByRole('button', { name: label, exact: true }));
    expect(onAction).toHaveBeenLastCalledWith(action);
  }
});
