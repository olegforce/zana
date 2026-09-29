import { beforeEach, expect, it, vi } from 'vitest';
import { IPC } from '@zana-ai/zcc-desktop-contract';
import { SHARED_PRODUCT_METHODS } from '@zana-ai/zcc-contracts/shared-product';
const state = vi.hoisted(() => ({ shared: new Map<string, Function>(), windows: new Map<string, Function>(), projects: [{ id: 'registered', path: '/registered' }] }));
vi.mock('electron', () => ({ dialog: {} }));
vi.mock('@zana-ai/zcc-server/services/projects/store', () => ({ store: { listProjects: () => state.projects } }));
vi.mock('../shared-product-registry.js', () => ({ registerSharedProduct: (channel: string, fn: Function) => { state.shared.set(channel, fn); } }));
import { bindIpcCtx } from '../ctx.js';
import { registerExecutionBoardIpc } from '../execution-board.js';
const get = vi.fn(), stop = vi.fn(), start = vi.fn(), list = vi.fn(), clear = vi.fn();
beforeEach(() => {
  state.shared.clear(); state.windows.clear(); vi.clearAllMocks();
  get.mockImplementation(async (projectId: string, id: string) => projectId === 'registered' && id === 'execution' ? { id, projectId, callerPrincipalId: 'stored-owner' } : undefined);
  stop.mockResolvedValue({ ok: false, code: 'CONFLICT', message: 'Version changed' });
  start.mockResolvedValue({ ok: true }); list.mockResolvedValue({ records: [], hasMore: false });
  bindIpcCtx({ safeHandle: vi.fn(), safeHandleFromWindow: (channel: string, fn: Function) => state.windows.set(channel, fn), ptys: { list: () => [] }, teams: { list: () => [] }, personas: { list: () => [] }, windows: new Map([[7, { projectId: 'different' }]]), executionStore: { getInProject: get }, executionResumeTokens: { clear }, executionSources: {}, squadExecutionService: { stop, listProject: list }, startTeamJobFromUi: start } as any);
  registerExecutionBoardIpc();
});
it('denies every shared execution operation for an unregistered project before reading execution state', async () => {
  for (const [method, channel] of SHARED_PRODUCT_METHODS) {
    if (!method.startsWith('executionBoard.')) continue;
    await state.shared.get(channel)!('foreign-project', 'execution', 1, 'work', 'slot');
  }
  expect(await state.shared.get(IPC.teams.startJob)!({ projectId: 'foreign-project' })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  expect(get).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled(); expect(clear).not.toHaveBeenCalled();
});
it('uses the execution store owner and project binding for a shared control', async () => {
  expect(await state.shared.get(IPC.executionBoard.stop)!('registered', 'execution', 3)).toMatchObject({ code: 'CONFLICT' });
  expect(stop).toHaveBeenCalledExactlyOnceWith('stored-owner', 'registered', 'execution', 3);
  expect(await state.shared.get(IPC.executionBoard.stop)!('registered', 'foreign-execution', 3)).toMatchObject({ code: 'NOT_FOUND' });
  expect(await state.shared.get(IPC.executionBoard.stop)!('registered', 'execution', '3')).toMatchObject({ code: 'INVALID' });
  expect(stop).toHaveBeenCalledOnce();
  expect(await state.shared.get(IPC.executionBoard.listProject)!('registered')).toEqual({ executions: [], hasMore: false });
});
it('does not fabricate a native window for shared launches and preserves local window confinement', async () => {
  const input = { projectId: 'registered' };
  await state.shared.get(IPC.teams.startJob)!(input);
  expect(start).toHaveBeenCalledExactlyOnceWith(input, undefined);
  expect(await state.windows.get(IPC.teams.startJob)!({ id: 7 }, input)).toMatchObject({ code: 'NOT_FOUND' });
  expect(start).toHaveBeenCalledOnce();
  await state.windows.get(IPC.teams.startJob)!({ id: 8 }, input);
  expect(start).toHaveBeenLastCalledWith(input, { windowId: 8 });
  expect(SHARED_PRODUCT_METHODS.has('executionBoard.relaunchMonitor')).toBe(false);
  expect(SHARED_PRODUCT_METHODS.has('executionSources.pick')).toBe(false);
});
it('contains a shared service failure without allowing any fallback launch', async () => {
  start.mockRejectedValueOnce(new Error('offline'));
  expect(await state.shared.get(IPC.teams.startJob)!({ projectId: 'registered' })).toMatchObject({ ok: false, code: 'UNAVAILABLE' });
  expect(start).toHaveBeenCalledOnce();
});
