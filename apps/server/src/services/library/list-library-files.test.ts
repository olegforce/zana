import { describe, expect, it, vi } from 'vitest';
import { listLibraryFiles } from './list-library-files.js';
import type { ProductHttpContext } from '../../http/product-context.js';
function fixture(run: (rel: string) => unknown) {
  const rpc = vi.fn(async ({ hostId, command }) => {
    expect(hostId).toBe('metadata-host');
    expect(command.root).toBe('/registered/project');
    expect(command.type).toBe('host.list_dir');
    return run(command.relPath);
  });
  return { rpc, ctx: { hostHub: { callHostOnlineRpc: rpc } } as unknown as ProductHttpContext };
}
const file = (name: string) => ({ name, kind: 'file', path: '/ignored' });
const directory = (name: string) => ({ name, kind: 'dir', path: '/ignored' });
describe('confined library listing', () => {
  it('uses one deadline for the complete walk instead of restarting it per directory', async () => {
    const { ctx, rpc } = fixture(() => ({ entries: [] }));
    await expect(listLibraryFiles(ctx, 'metadata-host', '/registered/project', '.zcc/library', Date.now() - 1)).rejects.toThrow('timed out');
    expect(rpc).not.toHaveBeenCalled();
    await listLibraryFiles(ctx, 'metadata-host', '/registered/project', '.zcc/library', Date.now() + 200);
    expect(rpc.mock.calls[0][0].timeoutMs).toBeLessThanOrEqual(200);
  });
  it('walks only library subdirectories and omits manifests', async () => {
    const { ctx, rpc } = fixture(rel => ({ entries: rel === '.zcc/library' ? [file('index.json'), directory('notes'), file('b.md')] : [file('a.md')] }));
    expect(await listLibraryFiles(ctx, 'metadata-host', '/registered/project', '.zcc/library')).toEqual(['b.md', 'notes/a.md']);
    expect(rpc).toHaveBeenCalledTimes(2);
  });
  it('accepts a missing library but propagates failures within an existing library', async () => {
    const missing = Object.assign(new Error('missing'), { code: 'path_not_found' });
    expect(await listLibraryFiles(fixture(() => { throw missing; }).ctx, 'metadata-host', '/registered/project', '.zcc/library')).toEqual([]);
    const { ctx } = fixture(rel => { if (rel === '.zcc/library') return { entries: [directory('sub')] }; throw missing; });
    await expect(listLibraryFiles(ctx, 'metadata-host', '/registered/project', '.zcc/library')).rejects.toThrow('missing');
  });
  it('fails visibly on truncated, malformed and cyclic listings', async () => {
    for (const entries of [Array.from({ length: 2000 }, (_, n) => file(`${n}.md`)), [file('../secret')], [directory('loop')]]) {
      await expect(listLibraryFiles(fixture(() => ({ entries })).ctx, 'metadata-host', '/registered/project', '.zcc/library')).rejects.toThrow();
    }
  });
  it('caps broad trees and propagates an offline owner', async () => {
    await expect(listLibraryFiles(fixture(() => ({ entries: Array.from({ length: 100 }, (_, n) => directory(`${n}`)) })).ctx, 'metadata-host', '/registered/project', '.zcc/library')).rejects.toThrow();
    await expect(listLibraryFiles(fixture(() => { throw new Error('offline'); }).ctx, 'metadata-host', '/registered/project', '.zcc/library')).rejects.toThrow('offline');
  });
});
