import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { invokeRemoteLibraryTool } from './remote-library-tools.js';
import type { ProductHttpContext } from '../../http/product-context.js';
import type { Project } from '@zana-ai/zcc-domain/product';
function fixture() {
  const files = new Map<string, string>();
  const rpc = vi.fn(async ({ hostId, command: c }: any) => {
    expect(hostId).toBe('metadata-owner');
    expect(c.root ?? c.rootPath).toBe('/original');
    const rel = c.relPath?.replace(/^\.zcc\/library\//, '') ?? c.path?.replace('/original/', '').replace(/^\.zcc\/library\//, '');
    if (c.type === 'host.read_path') { if (!files.has(rel)) throw Object.assign(new Error('Missing'), { code: 'path_not_found' }); return { contentEncoding: 'utf8', content: files.get(rel), sha256: createHash('sha256').update(files.get(rel)!).digest('hex') }; }
    if (c.type === 'host.write_file') {
      const previous = files.get(rel);
      expect(c.expectedSha256).toBe(previous === undefined ? null : createHash('sha256').update(previous).digest('hex'));
      files.set(rel, c.content); return { outcome: 'written' };
    }
    if (c.type === 'host.remove_path') { expect(c.expectedSha256).toBe(createHash('sha256').update(files.get(rel)!).digest('hex')); files.delete(rel); return { ok: true }; }
    if (c.type === 'host.list_dir') return { entries: [...files.keys()].filter(name => !name.startsWith('.zcc/')).map(name => ({ name, kind: 'file', path: '/ignored' })) };
    throw new Error('Unexpected command');
  });
  const ctx = { hostHub: { resolveHostId: (id: string) => id, callHostOnlineRpc: rpc, ensureHostSessionReady: vi.fn() }, hub: { emit: vi.fn() } } as unknown as ProductHttpContext;
  const project = { id: 'project', path: '/original', hostId: 'metadata-owner', sources: [{ hostId: 'execution-host', path: '/checkout' }] } as Project;
  const invoke = (name: string, input: unknown = {}) => invokeRemoteLibraryTool(ctx, project, { name, input, threadId: 'executing-elsewhere', projectId: project.id });
  return { ctx, files, rpc, invoke };
}
it('writes, changes metadata, reads, lists and removes on the canonical owner with CAS', async () => {
  const { files, invoke } = fixture();
  await invoke('library_write', { relPath: 'note.md', content: 'shared content', title: 'Shared', tags: ['machine'] });
  await invoke('library_write', { relPath: 'note.md', title: 'Renamed' });
  const read = await invoke('library_read', { relPath: 'note.md' });
  expect(JSON.parse(read.contentItems[0]!.text!)).toMatchObject({ title: 'Renamed', content: 'shared content' });
  files.set('loose.txt', 'untracked');
  const list = JSON.parse((await invoke('library_list')).contentItems[0]!.text!);
  expect(list.map((doc: any) => doc.relPath)).toEqual(['loose.txt', 'note.md']);
  await invoke('library_remove', { relPath: 'note.md' });
  expect(files.has('note.md')).toBe(false);
  expect(JSON.parse(files.get('index.json')!).docs).toEqual([]);
  expect(JSON.parse((await invoke('library_remove', { relPath: 'missing.md' })).contentItems[0]!.text!).removed).toBe(false);
});
it('protects user documents, paths, absent content and concurrent writes', async () => {
  const { files, invoke, rpc } = fixture();
  files.set('user.md', '# User content');
  for (const name of ['library_write', 'library_remove']) await expect(invoke(name, { relPath: 'user.md', content: 'overwrite' })).rejects.toThrow('agent-authored');
  await expect(invoke('library_read', { relPath: '../escape.md' })).rejects.toThrow();
  await expect(invoke('library_read', { relPath: 'absent.md' })).rejects.toThrow('No such');
  await expect(invoke('library_write', { relPath: 'absent.md' })).rejects.toThrow('Pass content');
  await expect(invoke('library_write', { relPath: 'absent.md', content: 3 })).rejects.toThrow('string');
  await expect(invoke('unknown', { relPath: 'absent.md' })).rejects.toThrow('Unsupported');
  const normal = rpc.getMockImplementation()!;
  rpc.mockImplementation(async args => args.command.type === 'host.write_file' ? { outcome: 'conflict' } : normal(args));
  await expect(invoke('library_write', { relPath: 'note.txt', content: 'new' })).rejects.toThrow('concurrently');
});
it('fails on an offline owner, malformed manifests, binary or oversized content', async () => {
  const { ctx, files, invoke, rpc } = fixture();
  vi.mocked(ctx.hostHub.ensureHostSessionReady).mockImplementationOnce(() => { throw new Error('offline'); });
  await expect(invoke('library_list')).rejects.toThrow('offline');
  files.set('index.json', JSON.stringify({ docs: {} }));
  await expect(invoke('library_list')).rejects.toThrow('manifest');
  files.delete('index.json');
  await expect(invoke('library_write', { relPath: 'huge.txt', content: 'x'.repeat(10 * 1024 * 1024 + 1) })).rejects.toThrow('too large');
  rpc.mockResolvedValueOnce({ content: 'binary', contentEncoding: 'base64' } as any);
  await expect(invoke('library_list')).rejects.toThrow('binary');
});
