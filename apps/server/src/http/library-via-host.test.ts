import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { openDatabase, upsertHost } from '@zana-ai/zcc-db';
import type { HostListFilesResult, HostReadFileResult } from '@zana-ai/zcc-contracts/host-rpc';
import type { Project } from '@zana-ai/zcc-domain/product';
import { listLibraryDocs, readLibraryDoc, writeLibraryDoc } from './library-via-host.js';
import type { ProductHttpContext } from './product-context.js';

const primaryDir = mkdtempSync(join(tmpdir(), 'project-primary-'));
const primaryDb = openDatabase(join(primaryDir, 'test.sqlite'));
upsertHost(primaryDb, { id: 'host-1', name: 'Primary', hostKeyHash: 'a'.repeat(64) });
afterAll(() => { primaryDb.close(); rmSync(primaryDir, { recursive: true, force: true }); });

function project(overrides: Partial<Project> & Pick<Project, 'id' | 'name' | 'path'>): Project {
  return {
    createdAt: 1,
    lastActiveAt: 1,
    ...overrides
  };
}

function ctx(options: {
  dataDir: string;
  projects?: Project[];
  list?: HostListFilesResult;
  read?: HostReadFileResult;
}): ProductHttpContext {
  return {
    db: primaryDb,
    dataDir: options.dataDir,
    toProjects: () => options.projects ?? [],
    hostHub: {
      resolveHostId: (hostId?: string) => hostId ?? 'host-1',
      callHostOnlineRpc: async ({ command }: { command: { type: string; root: string; relPath: string } }) => {
        if (command.type === 'host.read_path') throw Object.assign(new Error('missing'), { code: 'path_not_found' });
        if (!options.list) return options.read ?? { entries: [] };
        const directory = `${command.root}/${command.relPath}`.replace(/\/$/, '');
        const entries = new Map<string, { name: string; kind: string; path: string }>();
        for (const file of options.list.files) {
          const absolute = `${file.root}/${file.relPath}`;
          if (!absolute.startsWith(`${directory}/`)) continue;
          const rest = absolute.slice(directory.length + 1);
          const name = rest.split('/')[0]!;
          entries.set(name, { name, kind: rest.includes('/') ? 'dir' : file.kind, path: `${directory}/${name}` });
        }
        return { entries: [...entries.values()] };
      }
    }
  } as unknown as ProductHttpContext;
}

describe('listLibraryDocs', () => {
  it('stamps absPath from the authorized root plus the host-relative path', async () => {
    const dataDir = '/tmp/zcc-data';
    const projectRoot = '/tmp/zana-builder';
    const docs = await listLibraryDocs(ctx({
      dataDir,
      projects: [project({ id: 'p1', name: 'zana-builder', path: projectRoot })],
      list: {
        files: [
          {
            root: `${dataDir}/library`,
            relPath: 'ideas/note.md',
            bytes: 12,
            kind: 'file'
          },
          {
            root: `${projectRoot}/.zcc/library`,
            relPath: 'findings/zana-builder-full-app-review-2026-08-17.md',
            bytes: 99,
            kind: 'file'
          }
        ]
      }
    }));

    expect(docs).toEqual([
      expect.objectContaining({
        relPath: 'ideas/note.md',
        scope: 'global',
        absPath: `${dataDir}/library/ideas/note.md`
      }),
      expect.objectContaining({
        relPath: 'findings/zana-builder-full-app-review-2026-08-17.md',
        scope: 'project',
        projectId: 'p1',
        projectName: 'zana-builder',
        absPath: `${projectRoot}/.zcc/library/findings/zana-builder-full-app-review-2026-08-17.md`
      })
    ]);
  });

  it('skips directories and the root manifest while retaining ordinary nested index.json documents', async () => {
    const dataDir = '/tmp/zcc-data';
    const docs = await listLibraryDocs(ctx({
      dataDir,
      list: {
        files: [
          { root: `${dataDir}/library`, relPath: 'findings', bytes: 0, kind: 'dir' },
          { root: `${dataDir}/library`, relPath: 'index.json', bytes: 2, kind: 'file' },
          { root: `${dataDir}/library`, relPath: 'notes/index.json', bytes: 2, kind: 'file' },
          { root: `${dataDir}/library`, relPath: 'notes/keep.md', bytes: 4, kind: 'file' }
        ]
      }
    }));
    expect(docs.map((doc) => doc.relPath)).toEqual(['notes/index.json', 'notes/keep.md']);
  });
});

describe('writeLibraryDoc', () => {
  it('rejects a path that escapes the library root', async () => {
    const result = await writeLibraryDoc(
      ctx({ dataDir: '/tmp/zcc-data' }),
      'global',
      '../secret',
      'nope'
    );
    expect(result).toMatchObject({ ok: false });
    expect(result.message).toContain('Invalid library path');
  });

  it('refuses a blind write with no read revision before issuing any host command', async () => {
    const context = ctx({ dataDir: '/tmp/zcc-data' });
    const rpc = vi.fn(); context.hostHub.callHostOnlineRpc = rpc;
    expect(await writeLibraryDoc(context, 'global', 'ideas/note.md', '# Hi\n')).toMatchObject({ ok: false });
    expect(rpc).not.toHaveBeenCalled();
  });
});

it('pins reads to the metadata owner and registered root despite a caller host override', async () => {
  const context = ctx({ dataDir: '/data', projects: [project({ id: 'p', name: 'P', path: '/code', hostId: 'owner', sources: [{ id: 'source', hostId: 'other', path: '/checkout', createdAt: 1 }] })] });
  const rpc = vi.fn(async ({ command }: any) => {
    if (command.path.endsWith('/library-transaction.json')) throw Object.assign(new Error('missing'), { code: 'path_not_found' });
    return { content: 'shared', contentEncoding: 'utf8' };
  });
  context.hostHub.callHostOnlineRpc = rpc;
  expect(await readLibraryDoc(context, 'project', 'note.md', 'p', 'other')).toEqual({ ok: true, content: 'shared', sha256: createHash('sha256').update('shared').digest('hex') });
  expect(rpc).toHaveBeenCalledWith({ hostId: 'owner', timeoutMs: expect.any(Number), command: { type: 'host.read_path', rootPath: '/code', boundaryPath: '/code/.zcc/library', path: '/code/.zcc/library/note.md' } });
});

it('uses the canonical document identity and metadata, stamping all authority fields itself', async () => {
  const context = ctx({ dataDir: '/data', projects: [project({ id: 'p', name: 'Project', path: '/code', hostId: 'owner' })] });
  context.hostHub.callHostOnlineRpc = vi.fn(async ({ hostId, command }: any) => {
    if (command.type === 'host.list_dir') return { entries: hostId === 'owner' ? [{ name: 'note.md', kind: 'file', path: '/forged' }] : [] };
    if (command.path.endsWith('/library/index.json') && hostId === 'owner') return { contentEncoding: 'utf8', content: JSON.stringify({ version: 1, docs: [{ id: 'stable-doc-id', relPath: 'note.md', title: 'Shared title', summary: 'Same everywhere', tags: ['shared'], kind: 'md', bytes: 40, createdAt: 1, updatedAt: 2, absPath: '/forged', projectId: 'other', scope: 'global' }] }) };
    throw Object.assign(new Error('missing'), { code: 'path_not_found' });
  }) as any;
  expect(await listLibraryDocs(context)).toEqual([expect.objectContaining({ id: 'stable-doc-id', title: 'Shared title', summary: 'Same everywhere', tags: ['shared'], absPath: '/code/.zcc/library/note.md', projectId: 'p', scope: 'project' })]);
});
