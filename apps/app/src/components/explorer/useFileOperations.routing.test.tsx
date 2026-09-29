// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { useFileOperations } from './useFileOperations.js';
const mocks = vi.hoisted(() => ({ list: vi.fn(), write: vi.fn(), toast: vi.fn(), view: vi.fn() }));
vi.mock('../../lib/product-client.js', () => ({ product: { terminals: { list: mocks.list, write: mocks.write } } }));
vi.mock('../../lib/copy-text.js', () => ({ copyText: vi.fn() }));
beforeEach(() => { vi.clearAllMocks(); mocks.list.mockResolvedValue([]); mocks.write.mockResolvedValue(undefined); });
function mount() { return renderHook(() => useFileOperations({ viewRoot: '/repo', isRemote: false, projectId: 'p', hostId: 'h', primaryHostId: 'primary', pushToast: mocks.toast })).result.current; }
it.each([
  [], [{ id: 't', hostId: 'other', cwd: '/repo' }], [{ id: 't', hostId: 'h', cwd: '/repo-other' }], [{ id: 't', cwd: '/repo' }]
].map(rows => ({ rows })))('does not paste a source path into another machine or checkout', async ({ rows }) => {
  mocks.list.mockResolvedValue(rows); await mount().sendPathToTerminal('/repo/file', () => 't', mocks.view);
  expect(mocks.write).not.toHaveBeenCalled(); expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('this machine'), 'error');
});
it('writes an absolute quoted path only to the matching machine', async () => {
  mocks.list.mockResolvedValue([{ id: 't', hostId: 'h', cwd: '/repo/sub' }]);
  await mount().sendPathToTerminal('/repo/file', () => 't', mocks.view);
  expect(mocks.write).toHaveBeenCalledWith('t', "'/repo/file' "); expect(mocks.view).toHaveBeenCalledWith('p', 'terminals');
});
it('handles no active tab and failed ownership reads without writes', async () => {
  const hook = mount(); await hook.sendPathToTerminal('/repo/file', () => undefined, mocks.view);
  mocks.list.mockRejectedValue(new Error('offline')); await hook.sendPathToTerminal('/repo/file', () => 't', mocks.view);
  expect(mocks.write).not.toHaveBeenCalled(); expect(mocks.toast).toHaveBeenLastCalledWith('offline', 'error');
});
