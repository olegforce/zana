import { expect, it, vi } from 'vitest';
import { managedPathOnHost } from './host-managed-path.js';
it('uses the chosen host data directory and rejects malformed host paths', async () => {
  const call = vi.fn(async () => ({ path: '/home/remote/.zcc/checkouts/zcc' }));
  const ctx = { dataDir: '/Users/server/.zcc', hostHub: { callHostOnlineRpc: call } } as any;
  expect(await managedPathOnHost(ctx, 'primary', 'primary', 'env', '/repo')).toContain('/Users/server/.zcc/'); expect(call).not.toHaveBeenCalled();
  const remote = await managedPathOnHost(ctx, 'other', 'primary', 'env', '/repo');
  expect(remote).toContain('/home/remote/.zcc/'); expect(remote).not.toContain('/Users/server');
  call.mockResolvedValueOnce({ path: '/wrong' });
  await expect(managedPathOnHost(ctx, 'other', 'primary', 'env', '/repo')).rejects.toThrow();
});
