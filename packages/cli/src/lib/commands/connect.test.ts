import { expect, it, vi } from 'vitest';
import { runCli } from '../run-cli.js';
const run = (args: string[], fetchImpl: any = vi.fn()) => runCli(['node', 'zcc', 'connect', ...args], { fetchImpl, serverUrl: 'http://127.0.0.1:8780' });
it.each([[], ['bogus'], ['expose'], ['expose', '22'], ['expose', '65536'], ['shares', 'extra'], ['expose', '3000', '--host'], ['expose', '3000', '--host', '--bad'], ['unexpose', '3000', '--unknown', 'remote']])('rejects invalid connect arguments %j', async (...args) => {
  expect((await run(args as string[])).exitCode).toBe(2);
});
it('uses product HTTP for sharing, listing and removal and returns URLs', async () => {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ enabled: true, shares: [{ hostName: 'Remote', port: 5173, status: 'ready', url: 'https://alice--5173.example.com', expiresAt: 1800000000000 }] })));
  expect((await run(['expose', '5173', '--host', 'remote'], fetchImpl)).stdout).toContain('https://alice--5173.example.com');
  expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: 'POST', body: JSON.stringify({ port: 5173, hostId: 'remote' }) });
  expect(JSON.parse((await run(['shares', '--json'], fetchImpl)).stdout!).shares).toHaveLength(1);
  await run(['unexpose', '5173'], fetchImpl); expect(fetchImpl.mock.calls.at(-1)?.[1]).toMatchObject({ method: 'DELETE' });
});
it('propagates denied requests and handles empty shares', async () => {
  expect((await run(['shares'], async () => new Response(JSON.stringify({ error: 'Use share_preview' }), { status: 403 }))).stderr).toContain('share_preview');
  expect((await run(['shares'], async () => new Response(JSON.stringify({ shares: [] })))).stdout).toContain('No shared previews');
});
