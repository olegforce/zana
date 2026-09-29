import { expect, it, vi } from 'vitest';
import type { ProductHttpContext } from '../../http/product-context.js';
import { readProjectHistory } from './project-history.js';

function fixture() {
  const project = { id: 'p', path: '/canonical', hostId: 'owner', sources: [{ hostId: 'local', path: '/checkout' }] };
  const rows = [{ hash: 'a'.repeat(40), shortHash: 'aaaaaaa', author: 'Author', ts: 123, subject: 'Commit' }];
  const rpc = vi.fn(async () => rows), ready = vi.fn();
  const ctx = { toProjects: () => [project], hostHub: { resolveHostId: (id: string) => id, ensureHostSessionReady: ready, callHostOnlineRpc: rpc } } as unknown as ProductHttpContext;
  return { project, rows, rpc, ready, read: (raw: unknown = { projectId: 'p', limit: 50 }, deadline = Date.now() + 60_000) => readProjectHistory(ctx, raw, deadline) };
}
it('reads canonical project history on its recorded owner with bounded RPC time', async () => {
  const f = fixture(); expect(await f.read()).toEqual(f.rows);
  expect(f.ready).toHaveBeenCalledExactlyOnceWith('owner');
  expect(f.rpc).toHaveBeenCalledExactlyOnceWith({ hostId: 'owner', timeoutMs: 15_000, command: { type: 'host.git_history', root: '/canonical', limit: 50 } });
});
it('rejects caller hosts, paths, actions, missing projects, invalid limits and expired requests before RPC', async () => {
  const f = fixture();
  for (const raw of [{ projectId: 'unknown', limit: 50 }, { projectId: 'p', limit: 0 }, { projectId: 'p', limit: 101 }, { projectId: 'p', limit: 50, path: '/shadow' }, { projectId: 'p', limit: 50, hostId: 'local' }, { projectId: 'p', limit: 50, action: 'write' }]) await expect(f.read(raw)).rejects.toThrow();
  await expect(f.read(undefined, Date.now() - 1)).rejects.toThrow('timed out');
  Object.assign(f.project, { remote: {} }); await expect(f.read()).rejects.toThrow('legacy SSH');
  expect(f.rpc).not.toHaveBeenCalled();
});
it('never falls back to local history or empty success on owner failure and validates returned records', async () => {
  const f = fixture(); f.ready.mockImplementationOnce(() => { throw new Error('offline'); });
  await expect(f.read()).rejects.toThrow('offline'); expect(f.rpc).not.toHaveBeenCalled();
  f.rpc.mockRejectedValueOnce(new Error('lost owner')); await expect(f.read()).rejects.toThrow('lost owner');
  f.rpc.mockResolvedValueOnce([{ ...f.rows[0], hash: '../secret' }]); await expect(f.read()).rejects.toThrow();
  f.rpc.mockResolvedValueOnce([]); expect(await f.read()).toEqual([]);
});
