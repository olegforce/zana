import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { PROJECT_FEED_MAX_BYTES } from '@zana-ai/zcc-contracts/project-feed';
import { readHostPath, readHostFileMetadata, writeHostFile } from '../../../../host-daemon/src/host-fs.js';
import type { ProductHttpContext } from '../../http/product-context.js';
import { projectFeed } from './project-feed.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const input = (key = 'one') => ({ projectId: 'p', kind: 'commit' as const, ts: 123, title: key, dedupeKey: key });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'owner-feed-')); roots.push(root);
  let projects = [{ id: 'p', path: root, hostId: 'owner', sources: [{ hostId: 'primary', path: '/wrong-source' }] }];
  const run = async ({ command }: any): Promise<any> => {
    if (command.type === 'host.file_metadata') return readHostFileMetadata(command);
    if (command.type === 'host.read_path') return readHostPath(command);
    if (command.type === 'host.write_file') return writeHostFile(command);
    throw new Error('Unexpected command');
  };
  const rpc = vi.fn(run), ready = vi.fn();
  const ctx = { toProjects: () => projects, hostHub: { resolveHostId: (id: string) => id, ensureHostSessionReady: ready, callHostOnlineRpc: rpc } } as unknown as ProductHttpContext;
  return { root, file: join(root, '.zcc', 'activity.jsonl'), rpc, run, ready, ctx, remove: () => { projects = []; },
    list: () => projectFeed(ctx, { action: 'list', projectId: 'p' }),
    append: (events = [input()]) => projectFeed(ctx, { action: 'append', projectId: 'p', events }) };
}
it('uses the original owner, preserves existing IDs, serializes additions and deduplicates retries', async () => {
  const f = await fixture(); expect((await f.list()).events).toEqual([]);
  await mkdir(join(f.root, '.zcc')); await writeFile(f.file, JSON.stringify({ ...input('old'), id: 'legacy-event' }) + '\n');
  const [a, b] = await Promise.all([f.append([input('a')]), f.append([input('b')])]);
  expect(a.added).toBe(1); expect(b.events).toHaveLength(3); expect(b.events.find(event => event.dedupeKey === 'old')!.id).toBe('legacy-event');
  expect((await f.append([input('a')])).added).toBe(0);
  expect((await f.list()).events).toEqual(b.events);
  for (const [call] of f.rpc.mock.calls) expect(call).toMatchObject({ hostId: 'owner', command: { rootPath: f.root, boundaryPath: join(f.root, '.zcc'), path: f.file } });
});
it.each(['path', 'hostId', 'remote'] as const)('fences an in-place %s owner change between host calls', async field => {
  const f = await fixture(); await mkdir(join(f.root, '.zcc')); await writeFile(f.file, JSON.stringify({ ...input(), id: 'old' }) + '\n');
  f.rpc.mockImplementation(async args => {
    const result = await f.run(args);
    if (args.command.type === 'host.file_metadata') Object.assign(f.ctx.toProjects()[0], { [field]: field === 'remote' ? {} : '/changed' });
    return result;
  });
  await expect(f.append([input('new')])).rejects.toThrow('owner changed');
  expect(f.rpc.mock.calls.map(([call]) => call.command.type)).toEqual(['host.file_metadata']);
  expect((await readFile(f.file, 'utf8'))).not.toContain('new');
});
it('does not publish conflicts or overwrite damaged JSONL, and recovers an exact lost acknowledgement', async () => {
  const f = await fixture();
  let lose = true;
  f.rpc.mockImplementation(async args => { const result = await f.run(args); if (args.command.type === 'host.write_file' && lose) { lose = false; throw new Error('lost reply'); } return result; });
  expect((await f.append()).added).toBe(1);
  f.rpc.mockImplementation(async args => args.command.type === 'host.write_file' ? { outcome: 'conflict', currentSha256: 'a'.repeat(64) } : f.run(args));
  await expect(f.append([input('conflict')])).rejects.toThrow('changed');
  expect((await f.list()).events).toHaveLength(1);
  const previous = await readFile(f.file, 'utf8'); await writeFile(f.file, previous + '{torn\n');
  expect((await f.list()).events).toHaveLength(1);
  await expect(f.append()).rejects.toThrow('invalid records'); expect(await readFile(f.file, 'utf8')).toBe(previous + '{torn\n');
});
it('enforces scope, size, deadline and nested filesystem confinement', async () => {
  const f = await fixture();
  for (const raw of [{ action: 'list', projectId: 'unknown' }, { action: 'list', projectId: 'p', hostId: 'primary' }, { action: 'append', projectId: 'p', events: [{ ...input(), projectId: 'other' }] }]) await expect(projectFeed(f.ctx, raw)).rejects.toThrow();
  await expect(projectFeed(f.ctx, { action: 'list', projectId: 'p' }, Date.now() - 1)).rejects.toThrow('timed out');
  f.ready.mockImplementationOnce(() => { throw new Error('offline'); }); await expect(f.list()).rejects.toThrow('offline');
  expect(f.rpc).not.toHaveBeenCalled();
  await mkdir(join(f.root, '.zcc')); await writeFile(f.file, 'x'.repeat(PROJECT_FEED_MAX_BYTES + 1)); await expect(f.list()).rejects.toThrow('too large');
  await rm(join(f.root, '.zcc'), { recursive: true }); const outside = await mkdtemp(join(tmpdir(), 'feed-outside-')); roots.push(outside);
  await symlink(outside, join(f.root, '.zcc')); await expect(f.append()).rejects.toThrow();
  expect(await readFile(join(outside, 'activity.jsonl')).catch(() => null)).toBeNull();
});
it('bounds retained records and bytes and rejects oversized aggregate requests', async () => {
  const f = await fixture(); await mkdir(join(f.root, '.zcc'));
  await writeFile(f.file, Array.from({ length: 505 }, (_, n) => JSON.stringify({ ...input(String(n)), id: String(n), ts: n })).join('\n'));
  expect((await f.list()).events).toHaveLength(500);
  await f.append(); expect((await f.list()).events).toHaveLength(500);
  await expect(f.append(Array.from({ length: 20 }, (_, n) => ({ ...input(`large-${n}`), title: 'x'.repeat(250_000) })))).rejects.toThrow('too large');
  for (let batch = 0; batch < 3; batch++) await f.append(Array.from({ length: 6 }, (_, n) => ({ ...input(`${batch}-${n}`), ts: 1000 + batch, title: 'x'.repeat(250_000) })));
  expect(Buffer.byteLength(await readFile(f.file, 'utf8'))).toBeLessThanOrEqual(PROJECT_FEED_MAX_BYTES);
});
it('retains authority through queued changes and bounds pending operations', async () => {
  const f = await fixture(); let release!: () => void;
  f.rpc.mockImplementationOnce(async args => { await new Promise<void>(resolve => { release = resolve; }); return f.run(args); });
  const first = f.list(); await Promise.resolve(); await Promise.resolve();
  const queued = Array.from({ length: 99 }, () => f.list());
  await expect(f.list()).rejects.toThrow('Too many');
  f.remove(); release();
  await first; // A missing file response was already authorized; queued operations must re-resolve.
  for (const task of queued) await expect(task).rejects.toThrow('Unknown');
});

it('limits simultaneous owner reads across projects', async () => {
  const f = await fixture();
  const projects = Array.from({ length: 12 }, (_, n) => ({ id: `p${n}`, path: `${f.root}/${n}`, hostId: 'owner' }));
  f.ctx.toProjects = () => projects as any;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let active = 0, maximum = 0;
  f.rpc.mockImplementation(async () => {
    active++; maximum = Math.max(maximum, active);
    await gate; active--;
    throw Object.assign(new Error('missing'), { code: 'path_not_found' });
  });
  const tasks = projects.map(project => projectFeed(f.ctx, { action: 'list', projectId: project.id }));
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(f.rpc).toHaveBeenCalledTimes(4);
  release(); await Promise.all(tasks);
  expect(maximum).toBe(4); expect(f.rpc).toHaveBeenCalledTimes(12);
});

it('bounds queued event payloads before reaching the operation-count cap', async () => {
  const f = await fixture(); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.rpc.mockImplementationOnce(async args => { await gate; return f.run(args); });
  const events = Array.from({ length: 20 }, (_, n) => ({ ...input(`large-${n}`), title: 'x'.repeat(200_000) }));
  const tasks = Array.from({ length: 8 }, () => f.append(events).catch(error => error));
  await expect(f.append(events)).rejects.toThrow('Too many pending activity feed operations');
  f.remove(); release(); await Promise.all(tasks);
  // The retained-byte reservation is released on both success and failure.
  await expect(f.list()).rejects.toThrow('Unknown activity feed project');
});
