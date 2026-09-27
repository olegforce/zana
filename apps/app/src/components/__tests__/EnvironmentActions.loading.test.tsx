// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EnvironmentActions } from '../EnvironmentActions.js';

const api = vi.hoisted(() => ({ status: vi.fn(), pullRequest: vi.fn(), action: vi.fn(), cancelProvision: vi.fn(), unsubscribe: vi.fn(), event: null as ((payload: unknown) => void) | null }));
vi.mock('../../lib/product-client.js', () => ({ product: { environments: api } }));
vi.mock('../../lib/product-ws.js', () => ({ subscribeProductEvent: (_name: string, listener: (payload: unknown) => void) => { api.event = listener; return api.unsubscribe; } }));
vi.mock('../../hooks/useCompactLayout.js', () => ({ useCompactLayout: () => true }));
const status = { dirty: true, branchName: 'main', defaultBranch: 'main', files: [{ path: 'src/mobile.ts', kind: 'modified' }] };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

it('shows git changes before PR lookup finishes, with no duplicate pending requests', async () => {
  const pr = deferred<{ pullRequest: null }>();
  api.status.mockResolvedValue(status);
  api.pullRequest.mockReturnValue(pr.promise);
  const { unmount } = render(<EnvironmentActions environmentId="env-1" />);
  await act(async () => {});
  expect(screen.getByText('1 changed file')).toBeTruthy();
  fireEvent.click(screen.getByText('Workspace actions'));
  expect(screen.getByRole('button', { name: 'Checking pull request…' }).hasAttribute('disabled')).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
  expect(api.status).toHaveBeenCalledTimes(3);
  expect(api.pullRequest).toHaveBeenCalledTimes(1);
  await act(async () => { pr.resolve({ pullRequest: null }); });
  expect(screen.getByRole('button', { name: 'Open pull request' }).hasAttribute('disabled')).toBe(false);
  unmount();
  expect(api.unsubscribe).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('ignores stale environment results and bounds pending status requests', async () => {
  const oldStatus = deferred<typeof status>();
  const oldPr = deferred<{ pullRequest: null }>();
  api.status.mockImplementation((id: string) => id === 'old' ? oldStatus.promise : Promise.resolve(status));
  api.pullRequest.mockImplementation((id: string) => id === 'old' ? oldPr.promise : Promise.resolve({ pullRequest: null }));
  const { rerender, unmount } = render(<EnvironmentActions environmentId="old" />);
  await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
  expect(api.status).toHaveBeenCalledTimes(1);
  expect(api.pullRequest).toHaveBeenCalledTimes(1);
  rerender(<EnvironmentActions environmentId="new" />);
  await act(async () => {});
  expect(screen.getByText('1 changed file')).toBeTruthy();
  await act(async () => {
    oldStatus.resolve({ ...status, branchName: 'stale', files: [] });
    oldPr.resolve({ pullRequest: null });
  });
  expect(screen.queryByText('stale')).toBeNull();
  expect(screen.getByText('1 changed file')).toBeTruthy();
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it('recovers after failed metadata requests', async () => {
  api.status.mockRejectedValueOnce(new Error('Offline')).mockResolvedValue(status);
  api.pullRequest.mockRejectedValueOnce(new Error('Unavailable')).mockResolvedValue({ pullRequest: null });
  render(<EnvironmentActions environmentId="env-1" />);
  await act(async () => {});
  expect(screen.queryByText('1 changed file')).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(screen.getByText('1 changed file')).toBeTruthy();
});

it.each([null, new Error('Commit failed'), 'Unknown failure'])('keeps commit behavior and reports its result (%s)', async (error) => {
  api.status.mockResolvedValue(status);
  api.pullRequest.mockResolvedValue({ pullRequest: null });
  if (error) api.action.mockRejectedValue(error);
  else api.action.mockResolvedValue({ message: 'Committed' });
  render(<EnvironmentActions environmentId="env-1" />);
  await act(async () => {});
  fireEvent.click(screen.getByText('Workspace actions'));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Commit', exact: true })); });
  expect(api.action).toHaveBeenCalledWith('env-1', { action: 'commit' });
  expect(screen.getByText(error instanceof Error ? error.message : error || 'Committed')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Commit', exact: true }).hasAttribute('disabled')).toBe(false);
});

it.each([false, true])('keeps provisioning cancellation reachable (failure=%s)', async (fail) => {
  api.status.mockResolvedValue(null);
  api.pullRequest.mockResolvedValue({ pullRequest: null });
  if (fail) api.cancelProvision.mockRejectedValue(new Error('Cancel failed'));
  else api.cancelProvision.mockResolvedValue({});
  render(<EnvironmentActions environmentId="env-1" />);
  await act(async () => {
    api.event?.({ kind: 'environment.provision.progress', payload: { text: 'Creating tree' } });
  });
  fireEvent.click(screen.getByText('Workspace actions'));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel', exact: true })); });
  expect(api.cancelProvision).toHaveBeenCalledWith('env-1');
  expect(screen.getByText(fail ? 'Cancel failed' : 'Provisioning cancelled')).toBeTruthy();
});
