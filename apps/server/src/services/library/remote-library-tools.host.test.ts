import { mkdtempSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { HostRpcCommandSchema } from '@zana-ai/zcc-contracts/host-rpc';
import type { Project } from '@zana-ai/zcc-domain/product';
import type { ProductHttpContext } from '../../http/product-context.js';
import { createCommandRuntime, dispatchHostCommand } from '../../../../host-daemon/src/command-dispatch.js';
import { invokeRemoteLibraryTool } from './remote-library-tools.js';

it('recovers through the real daemon filesystem handlers without copying metadata to another checkout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zcc-library-owner-'));
  const worker = mkdtempSync(join(tmpdir(), 'zcc-library-worker-'));
  try {
    const runtime = createCommandRuntime({ dataDir: root });
    let loseIndexReply = true;
    const rpc = vi.fn(async ({ hostId, command }: any) => {
      expect(hostId).toBe('owner');
      const result = await dispatchHostCommand(runtime, HostRpcCommandSchema.parse(command));
      if (loseIndexReply && command.type === 'host.write_file' && command.path.endsWith('/library/index.json')) {
        loseIndexReply = false; throw new Error('lost index response');
      }
      return result;
    });
    const ctx = { hostHub: { resolveHostId: (id?: string) => id ?? 'owner', ensureHostSessionReady: vi.fn(), callHostOnlineRpc: rpc }, hub: { emit: vi.fn() } } as unknown as ProductHttpContext;
    const project = { id: 'p', path: root, hostId: 'owner', sources: [{ id: 'worker', hostId: 'worker', path: worker }] } as Project;
    const invoke = (name: string, input: unknown) => invokeRemoteLibraryTool(ctx, project, { name, input, projectId: 'p', threadId: 'remote-thread' });
    const content = 'Shared metadata remains on its original machine.\n'.repeat(24_000);
    await expect(invoke('library_write', { relPath: 'shared.txt', title: 'Shared document', content })).rejects.toThrow('lost index response');
    const journal = join(root, '.zcc/library-transaction.json');
    expect(statSync(journal).mode & 0o777).toBe(0o600);
    const docId = JSON.parse(readFileSync(join(root, '.zcc/library/index.json'), 'utf8')).docs[0].id;
    const read = JSON.parse((await invoke('library_read', { relPath: 'shared.txt' })).contentItems[0]!.text!);
    expect(read).toMatchObject({ title: 'Shared document', content });
    expect(existsSync(journal)).toBe(false);
    expect(JSON.parse(readFileSync(join(root, '.zcc/library/index.json'), 'utf8')).docs[0].id).toBe(docId);
    expect(existsSync(join(worker, '.zcc'))).toBe(false);
    await invoke('library_write', { relPath: 'shared.txt', title: 'Updated' });
    await invoke('library_remove', { relPath: 'shared.txt' });
    expect(existsSync(join(root, '.zcc/library/shared.txt'))).toBe(false);
    expect(JSON.parse(readFileSync(join(root, '.zcc/library/index.json'), 'utf8')).docs).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(worker, { recursive: true, force: true }); }
});
