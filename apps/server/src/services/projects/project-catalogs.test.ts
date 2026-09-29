import { expect, it, vi } from 'vitest';
import { basename, join } from 'node:path';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createCommandRuntime, dispatchHostCommand } from '../../../../host-daemon/src/command-dispatch.js';
import { HostRpcCommandSchema } from '@zana-ai/zcc-contracts/host-rpc';
import type { ProductHttpContext } from '../../http/product-context.js';
import { readProjectCatalogs } from './project-catalogs.js';

function fixture() {
  const project = { id: 'p', path: '/original', hostId: 'owner', sources: [{ hostId: 'checkout', path: '/different' }] };
  const files = new Map([['one.json', '{"id":"one"}']]);
  const rpc = vi.fn(async ({ hostId, command }: any): Promise<any> => {
    expect(hostId).toBe('owner'); expect(command.root ?? command.rootPath).toBe('/original');
    expect(command.boundaryPath).toMatch(/^\/original\/\.zcc\/(personas|teams|templates)$/);
    if (command.type === 'host.list_dir') return { entries: [...files.keys()].map(name => ({ name, kind: 'file' })) };
    if (command.type === 'host.read_path') return { contentEncoding: 'utf8', content: files.get(basename(command.path)) };
    throw new Error('Unexpected mutation');
  });
  const ready = vi.fn();
  const ctx = { toProjects: () => [project], hostHub: { ensureHostSessionReady: ready, resolveHostId: (id: string) => id, callHostOnlineRpc: rpc } } as unknown as ProductHttpContext;
  return { ctx, project, rpc, ready, files, read: (raw: unknown = { projectId: 'p' }, deadline?: number) => readProjectCatalogs(ctx, raw, deadline) };
}
it('reads all catalogues only on the original owner within each catalogue boundary', async () => {
  const f = fixture();
  expect(await f.read()).toEqual({ projectId: 'p', hostId: 'owner', personas: ['{"id":"one"}'], teams: ['{"id":"one"}'], templates: ['{"id":"one"}'] });
  expect(f.ready).toHaveBeenCalledExactlyOnceWith('owner'); expect(f.rpc).toHaveBeenCalledTimes(6);
});
it('rejects caller-selected paths, hosts, actions, unknown projects and legacy SSH', async () => {
  const f = fixture();
  for (const raw of [{ projectId: 'missing' }, { projectId: 'p', hostId: 'checkout' }, { projectId: 'p', path: '/other' }, { projectId: 'p', action: 'write' }]) await expect(f.read(raw)).rejects.toThrow();
  Object.assign(f.project, { remote: {} }); await expect(f.read()).rejects.toThrow('legacy SSH'); expect(f.rpc).not.toHaveBeenCalled();
});
it('never substitutes empty data for an offline owner or failed read', async () => {
  const f = fixture(); f.ready.mockImplementation(() => { throw new Error('offline'); });
  await expect(f.read()).rejects.toThrow('offline'); expect(f.rpc).not.toHaveBeenCalled();
  f.ready.mockReset(); f.rpc.mockRejectedValue(new Error('lost reply')); await expect(f.read()).rejects.toThrow('lost reply');
  const normal = fixture(); normal.rpc.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'path_not_found' }));
  expect((await normal.read()).personas).toEqual([]);
  normal.rpc.mockResolvedValueOnce({ entries: [{ name: 'one.json', kind: 'file' }, { name: 'in-progress.tmp', kind: 'file' }] }).mockRejectedValueOnce(Object.assign(new Error('removed'), { code: 'path_not_found' }));
  expect((await normal.read()).personas).toEqual([]);
  normal.rpc.mockResolvedValueOnce({ entries: [{ name: 'one.json', kind: 'file' }] }).mockRejectedValueOnce(new Error('owner lost'));
  await expect(normal.read()).rejects.toThrow('owner lost');
});
it('bounds total directory entries, records, UTF-8 bytes and the aggregate deadline', async () => {
  const f = fixture();
  for (const entries of [Array.from({ length: 2000 }, () => ({ name: 'temp', kind: 'file' })), Array.from({ length: 257 }, (_, n) => ({ name: `${n}.json`, kind: 'file' })), [{ name: '../secret.json', kind: 'file' }], [{ name: 'link.json', kind: 'symlink' }]]) {
    f.rpc.mockResolvedValueOnce({ entries }); await expect(f.read()).rejects.toThrow();
  }
  f.rpc.mockResolvedValueOnce({ entries: [{ name: 'binary.json', kind: 'file' }] }).mockResolvedValueOnce({ contentEncoding: 'base64', content: 'e30=' });
  await expect(f.read()).rejects.toThrow('UTF-8');
  f.files.set('one.json', 'é'.repeat(140_000)); await expect(f.read()).rejects.toThrow('256 KiB');
  f.files.clear(); for (let i = 0; i < 9; i++) f.files.set(`${i}.json`, 'x'.repeat(250_000));
  await expect(f.read()).rejects.toThrow('2 MiB');
  const before = f.rpc.mock.calls.length; await expect(f.read({ projectId: 'p' }, Date.now() - 1)).rejects.toThrow('timed out'); expect(f.rpc).toHaveBeenCalledTimes(before);
});
it('the real host runtime rejects catalogue symlinks to private siblings and outside the project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'catalog-boundary-')), outside = await mkdtemp(join(tmpdir(), 'catalog-outside-'));
  const f = fixture(); f.project.path = root;
  const runtime = createCommandRuntime({ dataDir: root });
  f.rpc.mockImplementation(({ command }: any) => dispatchHostCommand(runtime, HostRpcCommandSchema.parse(command)));
  try {
    await mkdir(join(root, '.zcc/personas'), { recursive: true }); await mkdir(join(root, 'private'));
    await writeFile(join(root, '.zcc/personas/one.json'), '{"id":"owner"}');
    expect((await f.read()).personas).toEqual(['{"id":"owner"}']);
    await writeFile(join(root, 'private/secret.json'), '{"secret":true}');
    await symlink(join(root, 'private/secret.json'), join(root, '.zcc/personas/linked.json'));
    await expect(f.read()).rejects.toThrow();
    await rm(join(root, '.zcc/personas'), { recursive: true });
    await symlink(outside, join(root, '.zcc/personas')); await expect(f.read()).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
