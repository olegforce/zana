import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProductHttpContext } from '../../http/product-context.js';
import { invokeHostLibraryTool, kindFromExt, parseFrontMatter, serializeFrontMatter, validateAgentRelPath } from './host-library-tools.js';

import { createCommandRuntime, dispatchHostCommand } from '../../../../host-daemon/src/command-dispatch.js';
import { HostRpcCommandSchema } from '@zana-ai/zcc-contracts/host-rpc';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function ctx(root: string): ProductHttpContext {
  roots.push(root);
  const runtime = createCommandRuntime({ dataDir: root });
  return {
    dataDir: root,
    hostHub: { resolveHostId: (id: string) => id, ensureHostSessionReady: vi.fn(), callHostOnlineRpc: ({ command }: any) => dispatchHostCommand(runtime, HostRpcCommandSchema.parse(command)) },
    toProjects: () => [{ id: 'proj-1', name: 'Demo', path: root, hostId: 'primary' }],
    hub: { emit: () => undefined, size: () => 1 }
  } as unknown as ProductHttpContext;
}

describe('invokeHostLibraryTool', () => {
  it('rejects unavailable owners and unknown projects instead of reading a local shadow', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zcc-lib-offline-'));
    const product = ctx(root);
    product.hostHub.ensureHostSessionReady = () => { throw new Error('owner offline'); };
    const input = { name: 'library_list', projectId: 'proj-1', input: {} };
    expect(await invokeHostLibraryTool(product, input)).toMatchObject({ success: false, contentItems: [{ text: expect.stringContaining('owner offline') }] });
    expect(await invokeHostLibraryTool(product, { ...input, projectId: 'absent' })).toMatchObject({ success: false, contentItems: [{ text: expect.stringContaining('not registered') }] });
    product.hostHub.ensureHostSessionReady = () => { throw 'disconnected'; };
    expect(await invokeHostLibraryTool(product, input)).toMatchObject({ success: false, contentItems: [{ text: expect.stringContaining('unavailable') }] });
    expect(await invokeHostLibraryTool(product, { ...input, input: { scope: 'global' } })).toMatchObject({ success: false });
  });
  it('refuses to clobber or delete a user-authored doc', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zcc-lib-user-'));
    const dir = join(root, '.zcc', 'library');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'notes.md'), '# user notes\n');
    writeFileSync(join(dir, 'index.json'), JSON.stringify({
      version: 1,
      docs: [{
        id: 'd1',
        relPath: 'notes.md',
        title: 'Notes',
        kind: 'md',
        createdAt: 1,
        updatedAt: 1,
        source: { kind: 'user' }
      }]
    }));
    const product = ctx(root);
    const write = await invokeHostLibraryTool(product, {
      name: 'library_write',
      threadId: 'thr-1',
      projectId: 'proj-1',
      input: { relPath: 'notes.md', content: 'nope' }
    });
    expect(write.success).toBe(false);
    const remove = await invokeHostLibraryTool(product, {
      name: 'library_remove',
      threadId: 'thr-1',
      projectId: 'proj-1',
      input: { relPath: 'notes.md' }
    });
    expect(remove.success).toBe(false);
    const missing = await invokeHostLibraryTool(product, {
      name: 'library_remove',
      threadId: 'thr-1',
      projectId: 'proj-1',
      input: { relPath: 'gone.md' }
    });
    expect(JSON.parse(missing.contentItems[0]?.text ?? '{}').removed).toBe(false);
  });

  it('updates metadata of an agent doc and lists untracked files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zcc-lib-meta-'));
    const product = ctx(root);
    await invokeHostLibraryTool(product, {
      name: 'library_write',
      threadId: 'thr-1',
      projectId: 'proj-1',
      input: { relPath: 'a.md', content: 'body', title: 'A' }
    });
    const updated = await invokeHostLibraryTool(product, {
      name: 'library_write',
      threadId: 'thr-1',
      projectId: 'proj-1',
      input: { relPath: 'a.md', title: 'Renamed', summary: 's' }
    });
    expect(updated.success).toBe(true);
    const extra = join(root, '.zcc', 'library', 'loose.txt');
    writeFileSync(extra, 'loose');
    const listed = await invokeHostLibraryTool(product, {
      name: 'library_list',
      threadId: 'thr-1',
      projectId: 'proj-1',
      input: {}
    });
    const docs = JSON.parse(listed.contentItems[0]?.text ?? '[]') as Array<{ relPath: string }>;
    expect(docs.some((d) => d.relPath === 'loose.txt')).toBe(true);
  });
});

it('validates reserved agent paths and classifies document formats', () => {
  for (const path of ['', ' ', '/etc/a', 'C:/etc/a', 'a/../b', 'a/.private', 'index.json']) expect(() => validateAgentRelPath(path)).toThrow();
  expect(() => validateAgentRelPath('reports/note.md')).not.toThrow();
  expect(['.md', '.markdown', '.pdf', '.PNG', '.jpg', '.txt'].map(kindFromExt)).toEqual(['md', 'md', 'pdf', 'image', 'image', 'other']);
});
it('recovers bounded front matter while preserving document bodies and malformed fences', () => {
  const raw = serializeFrontMatter({ id: 'stable', title: 'Title', summary: 'Summary', tags: ['one', 'two'], createdAt: 10, sourceKind: 'agent' }, 'body\n---body line');
  expect(parseFrontMatter(raw)).toEqual({ meta: { id: 'stable', title: 'Title', summary: 'Summary', tags: ['one', 'two'], createdAt: 10, sourceKind: 'agent' }, body: 'body\n---body line' });
  expect(parseFrontMatter('plain')).toBeNull();
  expect(parseFrontMatter('---\nno end')).toBeNull();
  expect(parseFrontMatter('---\nno colon\n---false\ntitle: "unterminated\ncreatedAt: invalid\ntags: []\n---')).toEqual({ meta: { title: '"unterminated' }, body: '' });
  expect(parseFrontMatter('---\ntags: [bare, "quoted"]\nsource: agent\n---\nbody')).toMatchObject({ meta: { tags: ['bare', 'quoted'], sourceKind: 'agent' }, body: 'body' });
  expect(serializeFrontMatter({ id: 'i', title: 'T', createdAt: 0 }, '')).not.toContain('tags:');
});
