import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { expect, it, vi } from 'vitest';
import { projectMetadataRecords } from './project-metadata-records.js';
import type { ProductHttpContext } from '../../http/product-context.js';
import { createCommandRuntime, dispatchHostCommand } from '../../../../host-daemon/src/command-dispatch.js';
import { HostRpcCommandSchema } from '@zana-ai/zcc-contracts/host-rpc';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const followup = (id = 'one', patch = {}) => JSON.stringify({ id, projectId: 'project', title: 'Question', ...patch });

function fixture() {
  const files = new Map<string, string>();
  const rpc = vi.fn(async ({ hostId, command: c }: any): Promise<any> => {
    expect(hostId).toBe('original-owner'); expect(c.root ?? c.rootPath).toBe('/original');
    const name = c.path ? basename(c.path) : '';
    if (c.type === 'host.list_dir') return { entries: [...files.keys()].map(name => ({ name, kind: 'file' })) };
    if (c.type === 'host.read_path') {
      if (!files.has(name)) throw Object.assign(new Error('Missing'), { code: 'path_not_found' });
      return { contentEncoding: 'utf8', content: files.get(name) };
    }
    if (c.type === 'host.write_file') {
      if ((files.has(name) ? hash(files.get(name)!) : null) !== c.expectedSha256) return { outcome: 'conflict' };
      files.set(name, c.content); return { outcome: 'written' };
    }
    if (c.type === 'host.remove_path') {
      if (!files.has(name)) throw Object.assign(new Error('Missing'), { code: 'path_not_found' });
      if (hash(files.get(name)!) !== c.expectedSha256) throw new Error('conflict');
      files.delete(name); return { ok: true };
    }
    throw new Error('Unexpected RPC');
  });
  const ready = vi.fn();
  const project = { id: 'project', path: '/original', hostId: 'original-owner', sources: [{ hostId: 'execution-host', path: '/checkout' }] };
  const ctx = { toProjects: () => [project], hostHub: { callHostOnlineRpc: rpc, ensureHostSessionReady: ready, resolveHostId: (id: string) => id } } as unknown as ProductHttpContext;
  const request = (input: object) => projectMetadataRecords(ctx, { projectId: 'project', kind: 'followups', ...input });
  return { ctx, files, rpc, ready, project, request };
}
it('keeps records on their original machine with revision-checked writes and deletes', async () => {
  const f = fixture(), content = followup();
  expect((await f.request({ action: 'list' })).records).toEqual([]);
  const created = await f.request({ action: 'write', id: 'one', content, expectedSha256: null });
  expect(created).toMatchObject({ hostId: 'original-owner', records: [{ id: 'one', content, sha256: hash(content) }] });
  expect((await f.request({ action: 'list' })).records).toEqual(created.records);
  await expect(f.request({ action: 'write', id: 'one', content: followup('one', { title: 'Other' }), expectedSha256: null })).rejects.toThrow('changed');
  await expect(f.request({ action: 'remove', id: 'one', expectedSha256: 'a'.repeat(64) })).rejects.toThrow('conflict');
  await f.request({ action: 'remove', id: 'one', expectedSha256: hash(content) });
  expect(f.files.size).toBe(0);
});
it('recognizes an exact committed write or removal after a lost reply without replay', async () => {
  const f = fixture(), normal = f.rpc.getMockImplementation()!;
  f.rpc.mockImplementation(async args => { const result = await normal(args); if (args.command.type !== 'host.read_path') throw new Error('lost reply'); return result; });
  await f.request({ action: 'write', id: 'one', content: followup(), expectedSha256: null });
  expect(f.rpc.mock.calls.filter(([x]) => x.command.type === 'host.write_file')).toHaveLength(1);
  await f.request({ action: 'remove', id: 'one', expectedSha256: hash(followup()) });
  expect(f.files.size).toBe(0);
});
it('never returns empty success or writes elsewhere when the owner is unavailable', async () => {
  const f = fixture();
  f.ready.mockImplementation(() => { throw new Error('owner offline'); });
  await expect(f.request({ action: 'list' })).rejects.toThrow('offline'); expect(f.rpc).not.toHaveBeenCalled();
  f.ready.mockReset(); f.rpc.mockRejectedValue(new Error('connection lost'));
  for (const input of [
    { action: 'list' }, { action: 'write', id: 'one', content: followup(), expectedSha256: null },
    { action: 'remove', id: 'one', expectedSha256: hash(followup()) }
  ]) await expect(f.request(input)).rejects.toThrow('connection lost');
});
it('accepts missing directories, concurrent removals and non-record temp files', async () => {
  const f = fixture(); f.rpc.mockRejectedValueOnce(Object.assign(new Error('Missing'), { code: 'path_not_found' }));
  expect((await f.request({ action: 'list' })).records).toEqual([]);
  f.files.set('in-progress.tmp', 'partial');
  f.rpc.mockResolvedValueOnce({ entries: [{ kind: 'file', name: 'one.json' }, { kind: 'file', name: 'in-progress.tmp' }] });
  expect((await f.request({ action: 'list' })).records).toEqual([]);
});
it('denies caller paths, unregistered projects, malformed content and identity substitution', async () => {
  const f = fixture();
  for (const request of [
    { action: 'list', hostId: 'execution-host' }, { action: 'list', path: '/checkout' }, { action: 'list', kind: '../secrets' },
    { action: 'list', projectId: 'missing' }, { action: 'write', id: '../escape', content: followup(), expectedSha256: null },
    ...['not JSON', '{}', followup('another'), followup('one', { projectId: 'another' }), followup('one', { detail: 'é'.repeat(600_000) })].map(content => ({ action: 'write', id: 'one', content, expectedSha256: null }))
  ]) await expect(f.request(request)).rejects.toThrow();
  expect(f.rpc).not.toHaveBeenCalled();
  Object.assign(f.project, { remote: {} }); await expect(f.request({ action: 'list' })).rejects.toThrow('legacy SSH');
});
it('validates all metadata families and refuses binary, unsafe or oversized listings', async () => {
  const f = fixture();
  for (const [kind, value] of [
    ['goals', { id: 'one', projectId: 'project', title: 'Goal', statement: 'Do work' }],
    ['schedules', { id: 'one', projectId: 'project', name: 'Schedule', profile: 'shell', enabled: false, schedule: { every: '1h' } }]
  ] as const) { f.files.clear(); expect((await f.request({ kind, action: 'write', id: 'one', content: JSON.stringify(value), expectedSha256: null })).records).toHaveLength(1); }
  f.files.clear();
  for (const entries of [Array.from({ length: 2000 }, () => ({ name: 'one.json', kind: 'file' })), [{ name: '../escape.json', kind: 'file' }], [{ name: 'one.json', kind: 'dir' }]]) {
    f.rpc.mockResolvedValueOnce({ entries }); await expect(f.request({ action: 'list' })).rejects.toThrow();
  }
  f.files.set('one.json', followup());
  const normal = f.rpc.getMockImplementation()!;
  f.rpc.mockImplementation(async args => args.command.type === 'host.read_path' ? { contentEncoding: 'base64', content: '' } : normal(args));
  await expect(f.request({ action: 'list' })).rejects.toThrow('UTF-8');
  f.rpc.mockImplementation(normal); f.files.clear();
  for (let i = 0; i < 9; i++) f.files.set(`id${i}.json`, followup(`id${i}`, { detail: 'x'.repeat(950_000) }));
  await expect(f.request({ action: 'list' })).rejects.toThrow('8 MiB');
});
it('uses the real daemon atomic filesystem gate, preserving conflicts and denying symlink escape', async () => {
  const root = await mkdtemp(join(tmpdir(), 'metadata-host-test-'));
  const runtime = createCommandRuntime({ dataDir: root });
  const f = fixture(); f.project.path = root;
  f.rpc.mockImplementation(({ command }: any) => dispatchHostCommand(runtime, HostRpcCommandSchema.parse(command)));
  try {
    await f.request({ action: 'write', id: 'one', content: followup(), expectedSha256: null });
    const result = await f.request({ action: 'list' }); expect(result.records[0]?.sha256).toBe(hash(followup()));
    const file = join(root, '.zcc/followups/one.json'); await writeFile(file, followup('one', { title: 'external change' }));
    await expect(f.request({ action: 'remove', id: 'one', expectedSha256: hash(followup()) })).rejects.toThrow('changed');
    expect(await readFile(file, 'utf8')).toContain('external change');
    await rm(join(root, '.zcc/followups'), { recursive: true });
    const outside = await mkdtemp(join(tmpdir(), 'metadata-outside-test-'));
    try {
      await symlink(outside, join(root, '.zcc/followups'));
      await expect(f.request({ action: 'write', id: 'one', content: followup(), expectedSha256: null })).rejects.toThrow();
      await expect(readFile(join(outside, 'one.json'))).rejects.toThrow();
    } finally { await rm(outside, { recursive: true, force: true }); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('stops a long listing at the shared operation deadline before issuing another host command', async () => {
  const f = fixture();
  const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
  try {
    const payload = { action: 'list', projectId: 'project', kind: 'followups' };
    await expect(projectMetadataRecords(f.ctx, payload, 999)).rejects.toThrow('timed out');
    expect(f.rpc).not.toHaveBeenCalled();
    f.rpc.mockImplementationOnce(async () => { now.mockReturnValue(16_001); return { entries: [{ name: 'one.json', kind: 'file' }] }; });
    await expect(projectMetadataRecords(f.ctx, payload, 30_000)).rejects.toThrow('timed out');
    expect(f.rpc).toHaveBeenCalledTimes(1);
    expect(f.rpc.mock.calls[0][0]).toMatchObject({ timeoutMs: 15_000 });
  } finally { now.mockRestore(); }
});
