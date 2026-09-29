import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, upsertHost } from '@zana-ai/zcc-db';
import { HostRpcCommandSchema } from '@zana-ai/zcc-contracts/host-rpc';
import { LibraryDocumentRequestSchema } from '@zana-ai/zcc-contracts/library-documents';
import { createCommandRuntime, dispatchHostCommand } from '../../../../host-daemon/src/command-dispatch.js';
import type { ProductHttpContext } from '../../http/product-context.js';
import { libraryDocumentOperation } from './library-documents.js';
import { withProjectLibrary } from './project-library-queue.js';
import { maintainLibraryTransfer } from './library-transfer.js';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.useRealTimers(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'zcc-library-documents-'));
  const dataDir = join(root, 'primary'), owner = join(root, 'original'), checkout = join(root, 'checkout');
  for (const path of [dataDir, owner, checkout]) mkdirSync(path);
  const db = openDatabase(join(dataDir, 'test.sqlite'));
  upsertHost(db, { id: 'primary', name: 'Primary', hostKeyHash: 'a'.repeat(64) });
  const runtime = createCommandRuntime({ dataDir });
  const rpc = vi.fn(async ({ hostId, command }: any) => {
    expect(command.root ?? command.rootPath).toBe(hostId === 'owner' ? owner : dataDir);
    return dispatchHostCommand(runtime, HostRpcCommandSchema.parse(command));
  });
  const ctx = { db, dataDir, toProjects: () => [{ id: 'p', name: 'Original project', path: owner, hostId: 'owner', sources: [{ id: 'copy', hostId: 'primary', path: checkout }] }],
    hostHub: { resolveHostId: (id?: string) => id ?? 'primary', callHostOnlineRpc: rpc }, hub: { emit: vi.fn() } } as unknown as ProductHttpContext;
  cleanups.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const invoke = (request: unknown, deadline?: number) => libraryDocumentOperation(ctx, request, deadline) as Promise<any>;
  return { root, dataDir, owner, checkout, rpc, ctx, invoke, runtime };
}
const scoped = { scope: 'project', projectId: 'p', relPath: 'note.md' };
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

it.each(['project-to-global', 'global-to-project', 'project-to-project'])('transfers Library trees %s with stable identities and exact binary bytes', async direction => {
  const { invoke, dataDir, owner, checkout, ctx, rpc, runtime } = fixture();
  if (direction === 'project-to-project') {
    const projects = ctx.toProjects(); ctx.toProjects = () => [...projects, { id: 'q', name: 'Second project', path: checkout, hostId: 'second', createdAt: 0, lastActiveAt: 0 }];
    rpc.mockImplementation(async ({ command }) => dispatchHostCommand(runtime, HostRpcCommandSchema.parse(command)));
  }
  const local = { scope: 'global', relPath: 'folder' }, remote = { ...scoped, relPath: 'folder' };
  const from = direction === 'global-to-project' ? local : remote;
  const to = direction === 'project-to-global' ? local : direction === 'project-to-project' ? { ...remote, projectId: 'q' } : remote;
  const origin = from.scope === 'global' ? join(dataDir, 'library') : join(owner, '.zcc/library');
  const target = to.scope === 'global' ? join(dataDir, 'library') : join(direction === 'project-to-project' ? checkout : owner, '.zcc/library');
  const note = await invoke({ action: 'add', ...from, relPath: 'folder/note.md', title: 'Stable', content: 'Same body' });
  const binary = Buffer.from([0, 255, 254, 253]);
  await invoke({ action: 'import', ...from, relPath: 'folder/image.png', base64: binary.toString('base64') });
  mkdirSync(join(origin, 'folder/empty'));
  expect(await invoke({ action: 'move', from, to })).toMatchObject({ ok: true });
  expect(existsSync(join(origin, 'folder'))).toBe(false);
  expect(readFileSync(join(target, 'folder/image.png'))).toEqual(binary);
  expect(existsSync(join(target, 'folder/empty'))).toBe(true);
  expect((await invoke({ action: 'list' })).find((row: any) => row.id === note.id)).toMatchObject({ title: 'Stable', scope: to.scope, projectId: 'projectId' in to ? to.projectId : undefined });
  expect(existsSync(join(dataDir, 'library-transfer.json'))).toBe(false);
});

it.each(['marker', 'copy', 'destination-index', 'source-remove', 'source-index', 'cleanup'])('recovers a cross-root transfer after a lost %s reply without copying twice', async phase => {
  const { invoke, owner, dataDir, rpc } = fixture();
  const doc = await invoke({ action: 'add', ...scoped, title: 'Move', content: 'Exactly once' });
  const normal = rpc.getMockImplementation()!; let lose = true;
  rpc.mockImplementation(async value => {
    const result = await normal(value), c = value.command;
    const match = phase === 'marker' ? c.type === 'host.write_file' && c.path === join(dataDir, 'library-transaction.json')
      : phase === 'copy' ? c.type === 'host.write_file' && c.path === join(dataDir, 'library/note.md')
      : phase === 'destination-index' ? c.type === 'host.write_file' && c.path === join(dataDir, 'library/index.json')
      : phase === 'source-remove' ? c.type === 'host.remove_path' && c.path === join(owner, '.zcc/library/note.md')
      : phase === 'source-index' ? c.type === 'host.write_file' && c.path === join(owner, '.zcc/library/index.json')
      : c.type === 'host.remove_path' && c.path === join(owner, '.zcc/library-transaction.json');
    if (lose && match) { lose = false; throw new Error('reply lost'); }
    return result;
  });
  await expect(invoke({ action: 'move', from: scoped, to: { scope: 'global', relPath: 'note.md' } })).rejects.toThrow('reply lost');
  expect(existsSync(join(dataDir, 'library-transfer.json'))).toBe(true);
  expect((await invoke({ action: 'snapshot' })).docs).toEqual([expect.objectContaining({ id: doc.id, scope: 'global' })]);
  expect(existsSync(join(owner, '.zcc/library/note.md'))).toBe(false);
  expect(readFileSync(join(dataDir, 'library/note.md'), 'utf8')).toBe('Exactly once');
  expect(rpc.mock.calls.filter(([v]) => v.command.type === 'host.write_file' && v.command.path === join(dataDir, 'library/note.md'))).toHaveLength(1);
  expect(existsSync(join(dataDir, 'library-transfer.json'))).toBe(false);
});

it.each(['source', 'destination', 'metadata', 'owner'])('retains files and recovery evidence after external %s changes during a transfer', async change => {
  const { invoke, owner, dataDir, rpc, ctx } = fixture();
  await invoke({ action: 'add', ...scoped, title: 'Original', content: 'Original' });
  const normal = rpc.getMockImplementation()!; let lose = true;
  rpc.mockImplementation(async value => {
    const result = await normal(value);
    if (lose && value.command.type === 'host.write_file' && value.command.path === join(dataDir, 'library-transaction.json')) { lose = false; throw new Error('offline'); }
    return result;
  });
  const request = { action: 'move', from: scoped, to: { scope: 'global', relPath: 'note.md' } };
  await expect(invoke(request)).rejects.toThrow('offline');
  if (change === 'owner') { const projects = ctx.toProjects(); ctx.toProjects = () => projects.map(p => ({ ...p, path: p.path + '-moved' })); }
  else if (change === 'metadata') { const file = join(owner, '.zcc/library/index.json'), index = JSON.parse(readFileSync(file, 'utf8')); index.docs[0].title = 'External'; writeFileSync(file, JSON.stringify(index)); }
  else { const file = change === 'source' ? join(owner, '.zcc/library/note.md') : join(dataDir, 'library/note.md'); mkdirSync(join(dataDir, 'library'), { recursive: true }); writeFileSync(file, 'External'); }
  await expect(invoke(request)).rejects.toThrow(/changed/);
  expect(existsSync(join(owner, '.zcc/library/note.md'))).toBe(true);
  expect(existsSync(join(dataDir, 'library-transfer.json'))).toBe(true);
});

it('rejects cross-root collisions, unknown owners and corrupt recovery without overwriting files', async () => {
  const { invoke, owner, dataDir, ctx } = fixture();
  const request = { action: 'move' as const, from: scoped as any, to: { scope: 'global' as const, relPath: 'note.md' } };
  await expect(invoke(request)).rejects.toThrow('no longer exists');
  await invoke({ action: 'add', ...scoped, title: 'Original', content: 'Original' });
  await expect(invoke({ ...request, to: { ...scoped, projectId: 'unknown' } })).rejects.toThrow('not authorized');
  await invoke({ action: 'add', scope: 'global', relPath: 'note.md', title: 'Taken', content: 'Taken' });
  await expect(invoke(request)).rejects.toThrow('already exists');
  expect(existsSync(join(dataDir, 'library-transfer.json'))).toBe(false);
  const path = join(dataDir, 'library-transfer.json'); writeFileSync(path, '{bad');
  await expect(maintainLibraryTransfer(ctx, Date.now() + 1000)).rejects.toThrow();
  writeFileSync(path, ' '.repeat(3 * 1024 * 1024 + 1));
  await expect(maintainLibraryTransfer(ctx, Date.now() + 1000)).rejects.toThrow('too large');
  expect(readFileSync(join(owner, '.zcc/library/note.md'), 'utf8')).toBe('Original');
});

it('bounds the encoded transfer journal before reserving either root', async () => {
  const { invoke, owner, dataDir } = fixture();
  await invoke({ action: 'add', ...scoped, title: 'Original', content: 'Original' });
  const path = join(owner, '.zcc/library/index.json'), manifest = JSON.parse(readFileSync(path, 'utf8'));
  manifest.docs[0].summary = '\\'.repeat(800_000); writeFileSync(path, JSON.stringify(manifest));
  await expect(invoke({ action: 'move', from: scoped, to: { scope: 'global', relPath: 'note.md' } })).rejects.toThrow('journal is too large');
  expect(existsSync(join(dataDir, 'library-transfer.json'))).toBe(false);
  expect(existsSync(join(owner, '.zcc/library-transaction.json'))).toBe(false);
  expect(readFileSync(join(owner, '.zcc/library/note.md'), 'utf8')).toBe('Original');
});

it('rechecks source metadata after destination commit before removing any original bytes', async () => {
  const { invoke, owner, dataDir, rpc } = fixture();
  await invoke({ action: 'add', ...scoped, title: 'Original', content: 'Original' });
  const normal = rpc.getMockImplementation()!;
  rpc.mockImplementation(async value => {
    const result = await normal(value);
    if (value.command.type === 'host.write_file' && value.command.path === join(dataDir, 'library/index.json')) {
      const path = join(owner, '.zcc/library/index.json'), manifest = JSON.parse(readFileSync(path, 'utf8'));
      manifest.docs[0].title = 'External title'; writeFileSync(path, JSON.stringify(manifest));
    }
    return result;
  });
  await expect(invoke({ action: 'move', from: scoped, to: { scope: 'global', relPath: 'note.md' } })).rejects.toThrow('metadata changed');
  expect(readFileSync(join(owner, '.zcc/library/note.md'), 'utf8')).toBe('Original');
  expect(readFileSync(join(dataDir, 'library/note.md'), 'utf8')).toBe('Original');
});

it.each(['project', 'global'])('imports binary bytes and registers a stable user-owned document in %s', async scope => {
  const { invoke, owner, dataDir, checkout } = fixture();
  const location = { scope, ...(scope === 'project' ? { projectId: 'p' } : {}), relPath: 'upload.png' };
  const bytes = Buffer.from([0, 255, 1, 254]), path = join(scope === 'project' ? owner : dataDir, scope === 'project' ? '.zcc/library' : 'library', 'upload.png');
  const doc = await invoke({ action: 'import', ...location, base64: bytes.toString('base64') });
  expect(doc).toMatchObject({ ...location, source: { kind: 'user' }, kind: 'image', bytes: 4, title: 'upload.png' });
  expect(readFileSync(path)).toEqual(bytes); expect(existsSync(join(checkout, '.zcc/library/upload.png'))).toBe(false);
  expect((await invoke({ action: 'snapshot' })).docs.find((row: any) => row.id === doc.id)).toMatchObject(doc);
  expect(await invoke({ action: 'asset', ...location })).toMatchObject({ ok: true, dataUrl: `data:image/png;base64,${bytes.toString('base64')}` });
  await expect(invoke({ action: 'import', ...location, base64: 'AA==' })).rejects.toThrow('already exists'); expect(readFileSync(path)).toEqual(bytes);
});
it('rejects invalid uploads and collisions without overwriting existing unindexed bytes', async () => {
  const { invoke, owner } = fixture();
  const request = { action: 'import', ...scoped, relPath: 'empty.pdf' };
  for (const base64 of ['@@', 'AA', ' AA== ', 'A'.repeat(Math.ceil(10 * 1024 * 1024 / 3) * 4)]) {
    await expect(invoke({ ...request, base64 })).rejects.toThrow('Invalid or oversized');
  }
  await expect(invoke({ ...request, base64: '', source: { kind: 'agent' } })).rejects.toThrow();
  expect(await invoke({ ...request, base64: '' })).toMatchObject({ bytes: 0, kind: 'pdf' });
  writeFileSync(join(owner, '.zcc/library/unindexed.png'), Buffer.from([1, 255]));
  await expect(invoke({ ...request, relPath: 'unindexed.png', base64: 'AA==' })).rejects.toThrow('already exists');
  expect(readFileSync(join(owner, '.zcc/library/unindexed.png'))).toEqual(Buffer.from([1, 255]));
});
it('recovers a lost binary upload acknowledgement without replay or storing another copy of its bytes', async () => {
  const { invoke, rpc, owner } = fixture(); const normal = rpc.getMockImplementation()!; let lose = true;
  const bytes = Buffer.from([0, 255, 254, 253]);
  rpc.mockImplementation(async input => {
    const result = await normal(input);
    if (lose && input.command.type === 'host.write_file' && input.command.path.endsWith('/upload.png')) { lose = false; throw new Error('upload reply lost'); }
    return result;
  });
  await expect(invoke({ action: 'import', ...scoped, relPath: 'upload.png', base64: bytes.toString('base64') })).rejects.toThrow('upload reply lost');
  const journal = JSON.parse(readFileSync(join(owner, '.zcc/library-transaction.json'), 'utf8'));
  expect(journal).toMatchObject({ version: 1, beforeHash: null, afterHash: createHash('sha256').update(bytes).digest('hex') });
  expect(JSON.stringify(journal)).not.toContain(bytes.toString('base64'));
  expect((await invoke({ action: 'snapshot' })).docs).toEqual([expect.objectContaining({ id: journal.afterEntry.id, relPath: 'upload.png', bytes: 4 })]);
  expect(rpc.mock.calls.filter(([input]) => input.command.type === 'host.write_file' && input.command.path.endsWith('/upload.png'))).toHaveLength(1);
  expect(existsSync(join(owner, '.zcc/library-transaction.json'))).toBe(false);
});
it('rejects an invalid owner hash before it can authorize an upload', async () => {
  const { invoke, rpc, owner } = fixture(), normal = rpc.getMockImplementation()!;
  rpc.mockImplementation(async input => input.command.type === 'host.read_path' && input.command.path.endsWith('/upload.png')
    ? { contentEncoding: 'base64', content: 'AP8=', sha256: 'invalid' } : normal(input));
  await expect(invoke({ action: 'import', ...scoped, relPath: 'upload.png', base64: 'AA==' })).rejects.toThrow('Invalid Library document hash');
  expect(existsSync(join(owner, '.zcc/library/upload.png'))).toBe(false);
  expect(existsSync(join(owner, '.zcc/library-transaction.json'))).toBe(false);
});
it('preserves a file created by another writer between import inspection and commit', async () => {
  const { invoke, rpc, owner } = fixture(), normal = rpc.getMockImplementation()!;
  rpc.mockImplementation(async input => {
    if (input.command.type === 'host.write_file' && input.command.path.endsWith('/upload.png')) {
      mkdirSync(join(owner, '.zcc/library'), { recursive: true });
      writeFileSync(join(owner, '.zcc/library/upload.png'), Buffer.from([1, 2, 255]));
    }
    return normal(input);
  });
  await expect(invoke({ action: 'import', ...scoped, relPath: 'upload.png', base64: 'AA==' })).rejects.toThrow('existing bytes were preserved');
  expect(readFileSync(join(owner, '.zcc/library/upload.png'))).toEqual(Buffer.from([1, 2, 255]));
  const snapshot = await invoke({ action: 'snapshot' });
  expect(snapshot.roots.find((root: any) => root.projectId === 'p').state).toBe('unavailable');
  expect(existsSync(join(owner, '.zcc/library-transaction.json'))).toBe(false);
  const external = (await invoke({ action: 'snapshot' })).docs.find((doc: any) => doc.relPath === 'upload.png');
  expect(external).toMatchObject({ relPath: 'upload.png', id: 'project:p:upload.png' });
  expect(external.source).toBeUndefined(); // Preserve the unindexed file, never claim the failed upload's metadata.
});

it('updates addressed metadata despite another offline owner and verifies the id within that root', async () => {
  const { invoke, ctx, rpc, owner } = fixture();
  const doc = await invoke({ action: 'add', ...scoped, title: 'Accessible', content: 'original' });
  const normal = rpc.getMockImplementation()!;
  rpc.mockImplementation(async input => { if (input.hostId !== 'owner') throw new Error('Other machine offline'); return normal(input); });
  await expect(invoke({ action: 'update', id: doc.id, patch: { title: 'Legacy unknown location' } })).rejects.toThrow('Other machine offline');
  rpc.mockClear();
  expect(await invoke({ action: 'update', id: doc.id, patch: { title: 'Updated' }, location: scoped })).toMatchObject({ id: doc.id, title: 'Updated' });
  expect(rpc.mock.calls.every(([input]) => input.hostId === 'owner')).toBe(true);
  await expect(invoke({ action: 'update', id: 'wrong-id', patch: { title: 'No' }, location: scoped })).rejects.toThrow('changed');
  await expect(invoke({ action: 'remove', id: doc.id, location: { ...scoped, projectId: 'unknown' } })).rejects.toThrow('not authorized');
  expect(await invoke({ action: 'remove', id: doc.id, location: scoped })).toBe(true);
  expect(readFileSync(join(owner, '.zcc/library/note.md'), 'utf8')).toBe('original');
  expect(ctx.hub.emit).toHaveBeenCalled();
});

it('creates folders on the original owner and searches bodies with stable document identities', async () => {
  const { invoke, owner, checkout, rpc } = fixture();
  expect(await invoke({ action: 'search', query: '  ' })).toEqual({ hits: [], truncated: false }); expect(rpc).not.toHaveBeenCalled();
  expect(await invoke({ action: 'createFolder', ...scoped, relPath: 'notes/nested' })).toMatchObject({ ok: true });
  expect(existsSync(join(owner, '.zcc/library/notes/nested'))).toBe(true); expect(existsSync(join(checkout, '.zcc'))).toBe(false);
  await expect(invoke({ action: 'createFolder', ...scoped, relPath: 'notes/nested' })).rejects.toThrow();
  const doc = await invoke({ action: 'add', ...scoped, title: 'Title', content: '---\ntitle: metadata-only-needle\n---\nBody\nA CaSe InSeNsItIvE match' });
  const code = await invoke({ action: 'add', ...scoped, relPath: 'code.ts', title: 'Code', content: '// case insensitive match' });
  expect(await invoke({ action: 'search', query: 'metadata-only-needle' })).toEqual({ hits: [], truncated: false });
  expect((await invoke({ action: 'search', query: 'CASE INSENSITIVE' })).hits).toEqual(expect.arrayContaining([
    { docId: doc.id, scope: 'project', absPath: join(owner, '.zcc/library/note.md'), line: 2, preview: 'A CaSe InSeNsItIvE match' },
    { docId: code.id, scope: 'project', absPath: join(owner, '.zcc/library/code.ts'), line: 1, preview: '// case insensitive match' }
  ]));
  await invoke({ action: 'add', scope: 'global', relPath: 'note.md', title: 'Global', content: 'Global match' });
  expect((await invoke({ action: 'search', query: 'Global match' })).hits[0]).toMatchObject({ scope: 'global' });
});

it.each([{ ...scoped }, { scope: 'global', relPath: 'note.md' }])('creates, reads and revision-saves on the canonical owner: %j', async scope => {
  const { invoke, owner, dataDir, checkout, ctx } = fixture();
  const doc = await invoke({ action: 'add', ...scope, title: 'Shared document', summary: 'Description', tags: ['shared'], content: '# Original\n' });
  expect(doc).toMatchObject({ title: 'Shared document', source: { kind: 'user' }, ...scope });
  const read = await invoke({ action: 'read', ...scope }); expect(read).toMatchObject({ ok: true, content: '# Original\n', sha256: hash('# Original\n') });
  const saved = await invoke({ action: 'write', ...scope, content: '# Updated\n', expectedSha256: read.sha256 });
  expect(saved).toEqual({ ok: true, bytes: 10, sha256: hash('# Updated\n') });
  expect((await invoke({ action: 'list' })).find((row: any) => row.id === doc.id)).toMatchObject({ title: 'Shared document', summary: 'Description', tags: ['shared'] });
  const path = scope.scope === 'global' ? join(dataDir, 'library') : join(owner, '.zcc/library');
  expect(readFileSync(join(path, 'note.md'), 'utf8')).toBe('# Updated\n'); expect(existsSync(join(checkout, '.zcc'))).toBe(false);
  await expect(invoke({ action: 'write', ...scope, content: 'Stale save', expectedSha256: read.sha256 })).rejects.toThrow('changed');
  expect(readFileSync(join(path, 'note.md'), 'utf8')).toBe('# Updated\n'); expect(ctx.hub.emit).toHaveBeenCalledWith('library:changed', expect.any(Object));
});
it('preserves a hand edit and refuses a blind save or an add collision', async () => {
  const { invoke, owner } = fixture();
  await invoke({ action: 'add', ...scoped, title: 'Note', content: 'Original' });
  writeFileSync(join(owner, '.zcc/library/note.md'), 'External edit');
  await expect(invoke({ action: 'write', ...scoped, content: 'Overwrite', expectedSha256: hash('Original') })).rejects.toThrow('changed');
  await expect(invoke({ action: 'write', ...scoped, content: 'Blind write' })).rejects.toThrow();
  await expect(invoke({ action: 'add', ...scoped, title: 'Collision', content: 'Overwrite' })).rejects.toThrow('exists');
  expect(readFileSync(join(owner, '.zcc/library/note.md'), 'utf8')).toBe('External edit');
});
it('registers an existing loose file without rewriting it and edits metadata without rewriting bytes', async () => {
  const { invoke, owner } = fixture(); mkdirSync(join(owner, '.zcc/library'), { recursive: true });
  writeFileSync(join(owner, '.zcc/library/note.md'), 'Unchanged');
  const doc = await invoke({ action: 'add', ...scoped, title: 'Imported' });
  const edited = await invoke({ action: 'update', id: doc.id, patch: { title: 'New title', tags: ['tag'] } });
  expect(edited).toMatchObject({ id: doc.id, title: 'New title', tags: ['tag'], scope: 'project', projectId: 'p' });
  expect(readFileSync(join(owner, '.zcc/library/note.md'), 'utf8')).toBe('Unchanged');
  expect(await invoke({ action: 'remove', id: doc.id })).toBe(true);
  expect(existsSync(join(owner, '.zcc/library/note.md'))).toBe(true); // Remove unregisters; deleteEntry deletes bytes.
  expect(await invoke({ action: 'update', id: 'absent', patch: {} })).toBeNull();
  expect(await invoke({ action: 'remove', id: 'absent' })).toBe(false);
});
it('revision-saves a loose document and assigns a stable identity', async () => {
  const { invoke, owner } = fixture(); mkdirSync(join(owner, '.zcc/library'), { recursive: true });
  writeFileSync(join(owner, '.zcc/library/note.md'), 'Loose');
  await invoke({ action: 'write', ...scoped, content: 'Registered', expectedSha256: hash('Loose') });
  const listed = await invoke({ action: 'list' }); expect(listed[0]).toMatchObject({ title: 'note.md', source: { kind: 'user' } });
  await expect(invoke({ action: 'add', ...scoped, relPath: 'missing.md', title: 'No content' })).rejects.toThrow('Pass content');
});
it('recovers an interrupted document/index transaction without replaying the content write', async () => {
  const { invoke, rpc, owner } = fixture(); const normal = rpc.getMockImplementation()!; let lose = true;
  rpc.mockImplementation(async value => {
    const result = await normal(value);
    if (lose && value.command.type === 'host.write_file' && value.command.path.endsWith('/library/index.json')) { lose = false; throw new Error('index reply lost'); }
    return result;
  });
  await expect(invoke({ action: 'add', ...scoped, title: 'Interrupted', content: 'Saved exactly once' })).rejects.toThrow('reply lost');
  expect(existsSync(join(owner, '.zcc/library-transaction.json'))).toBe(true);
  const read = await invoke({ action: 'read', ...scoped }); expect(read.content).toBe('Saved exactly once');
  const doc = (await invoke({ action: 'list' }))[0]; expect(doc.title).toBe('Interrupted');
  expect(existsSync(join(owner, '.zcc/library-transaction.json'))).toBe(false);
  expect(rpc.mock.calls.filter(([value]) => value.command.type === 'host.write_file' && value.command.path.endsWith('/library/note.md'))).toHaveLength(1);
});
it('rejects unknown projects, forged roots and traversal before mutation', async () => {
  const { invoke, rpc, owner, checkout } = fixture();
  for (const patch of [{ projectId: 'missing' }, { relPath: '../escape' }, { relPath: 'index.json' }, { hostId: 'primary' }, { root: checkout }, { source: { kind: 'agent' } }]) {
    await expect(invoke({ action: 'add', ...scoped, title: 'No', content: 'No', ...patch })).rejects.toThrow();
  }
  expect(rpc).not.toHaveBeenCalled(); expect(existsSync(join(owner, '.zcc'))).toBe(false);
  mkdirSync(join(owner, '.zcc/library'), { recursive: true }); symlinkSync(checkout, join(owner, '.zcc/library/escape'));
  await expect(invoke({ action: 'add', ...scoped, relPath: 'escape/no.md', title: 'No', content: 'No' })).rejects.toThrow();
  expect(existsSync(join(checkout, 'no.md'))).toBe(false);
});
it('bounds content bytes and queued operations, and does not mutate after deadline', async () => {
  const { invoke, rpc } = fixture();
  await expect(invoke({ action: 'add', ...scoped, title: 'Late', content: 'late' }, Date.now() - 1)).rejects.toThrow('timed out'); expect(rpc).not.toHaveBeenCalled();
  await expect(invoke({ action: 'add', ...scoped, title: 'Large', content: 'é'.repeat(6 * 1024 * 1024) })).rejects.toThrow('too large');
  let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
  const pending = Array.from({ length: 100 }, () => withProjectLibrary('blocked', () => blocked));
  await expect(withProjectLibrary('another', async () => undefined)).rejects.toThrow('Too many'); release(); await Promise.all(pending);
  await expect(withProjectLibrary('blocked', async () => { throw new Error('expected'); })).rejects.toThrow('expected');
  expect(await withProjectLibrary('blocked', async () => 'next')).toBe('next');
  const failure = withProjectLibrary('same', async () => { throw new Error('previous failed'); });
  const next = withProjectLibrary('same', async () => 'survives');
  await expect(failure).rejects.toThrow('previous failed'); expect(await next).toBe('survives');
});
it('confines a Library symlink inside its own root, not merely inside its project', async () => {
  const { invoke, owner } = fixture(); mkdirSync(join(owner, '.zcc/library'), { recursive: true });
  mkdirSync(join(owner, 'private')); writeFileSync(join(owner, 'private/secret.md'), 'Private project file');
  symlinkSync(join(owner, 'private'), join(owner, '.zcc/library/escape'));
  for (const request of [
    { action: 'read', ...scoped, relPath: 'escape/secret.md' },
    { action: 'add', ...scoped, relPath: 'escape/new.md', title: 'No', content: 'No' },
    { action: 'list' }
  ]) await expect(invoke(request)).rejects.toThrow(/boundary|root/);
  expect(existsSync(join(owner, 'private/new.md'))).toBe(false);
  expect(readFileSync(join(owner, 'private/secret.md'), 'utf8')).toBe('Private project file');
});
it('refuses malformed manifests, ambiguous paths and binary edits', async () => {
  const { invoke, owner } = fixture(); mkdirSync(join(owner, '.zcc/library'), { recursive: true });
  const path = join(owner, '.zcc/library/index.json');
  writeFileSync(path, JSON.stringify({ version: 2, docs: [] })); await expect(invoke({ action: 'add', ...scoped, title: 'No', content: '' })).rejects.toThrow('manifest');
  writeFileSync(path, JSON.stringify({ version: 1, docs: [{ id: 'a', relPath: 'note.md' }, { id: 'b', relPath: 'note.md' }] })); await expect(invoke({ action: 'add', ...scoped, title: 'No', content: '' })).rejects.toThrow('Ambiguous');
  writeFileSync(path, JSON.stringify({ version: 1, docs: [] })); writeFileSync(join(owner, '.zcc/library/note.md'), Buffer.from([255, 254, 253]));
  expect(await invoke({ action: 'read', ...scoped })).toMatchObject({ ok: false, binary: true });
  await expect(invoke({ action: 'write', ...scoped, content: 'No', expectedSha256: hash('') })).rejects.toThrow('binary');
});
it('keeps the previous bytes on a host-side compare-and-swap conflict', async () => {
  const { invoke, owner, rpc } = fixture(); await invoke({ action: 'add', ...scoped, title: 'Original', content: 'Original' });
  const normal = rpc.getMockImplementation()!; rpc.mockImplementation(async value => {
    if (value.command.type === 'host.write_file' && value.command.path.endsWith('/library/note.md')) writeFileSync(join(owner, '.zcc/library/note.md'), 'Race winner');
    return normal(value);
  });
  await expect(invoke({ action: 'write', ...scoped, content: 'Lost', expectedSha256: hash('Original') })).rejects.toThrow('concurrently');
  expect(readFileSync(join(owner, '.zcc/library/note.md'), 'utf8')).toBe('Race winner');
});
it('validates global/project scope and rejects unknown request fields', () => {
  for (const value of [{ action: 'read', scope: 'project', relPath: 'a.md' }, { action: 'read', scope: 'global', projectId: 'p', relPath: 'a.md' }, { action: 'list', hostId: 'forged' }, { action: 'write', ...scoped, content: 'x', expectedSha256: 'invalid' }]) expect(LibraryDocumentRequestSchema.safeParse(value).success).toBe(false);
});

it('moves binary files and directories on the owner, retaining document IDs, then deletes only that tree', async () => {
  const { invoke, owner, checkout } = fixture();
  const loc = (relPath: string) => ({ ...scoped, relPath });
  const doc = await invoke({ action: 'add', ...loc('old/note.md'), title: 'Stable title', content: 'Original bytes' });
  mkdirSync(join(owner, '.zcc/library/old/empty'));
  const binary = Buffer.from([0, 255, 254, 253]); writeFileSync(join(owner, '.zcc/library/old/file.pdf'), binary);
  const pdf = await invoke({ action: 'add', ...loc('old/file.pdf'), title: 'Binary document' });
  expect(pdf).toMatchObject({ kind: 'pdf', bytes: 4 });
  writeFileSync(join(owner, '.zcc/library/old/index.json'), '{"ordinary":"document"}');
  expect(await invoke({ action: 'move', from: loc('old'), to: loc('parent/new') })).toMatchObject({ ok: true });
  expect(existsSync(join(owner, '.zcc/library/old'))).toBe(false);
  expect(readFileSync(join(owner, '.zcc/library/parent/new/file.pdf'))).toEqual(binary);
  expect(existsSync(join(owner, '.zcc/library/parent/new/empty'))).toBe(true);
  expect((await invoke({ action: 'list' })).find((row: any) => row.id === doc.id)).toMatchObject({ title: 'Stable title', relPath: 'parent/new/note.md' });
  expect((await invoke({ action: 'list' })).find((row: any) => row.id === pdf.id)).toMatchObject({ title: 'Binary document', relPath: 'parent/new/file.pdf' });
  expect((await invoke({ action: 'list' })).some((row: any) => row.relPath === 'parent/new/index.json')).toBe(true);
  expect(existsSync(join(checkout, '.zcc'))).toBe(false);
  expect(await invoke({ action: 'deleteEntry', ...loc('parent/new') })).toMatchObject({ ok: true });
  expect(await invoke({ action: 'list' })).toEqual([]); expect(existsSync(join(owner, '.zcc/library/parent/new'))).toBe(false);
  await invoke({ action: 'add', scope: 'global', relPath: 'single.txt', title: 'Global', content: '' });
  await invoke({ action: 'move', from: { scope: 'global', relPath: 'single.txt' }, to: { scope: 'global', relPath: 'moved.txt' } });
  await invoke({ action: 'deleteEntry', scope: 'global', relPath: 'moved.txt' });
  expect(await invoke({ action: 'list' })).toEqual([]);
});

it.each(['mkdir', 'copy', 'remove', 'index', 'journal'])('recovers a move after losing the %s acknowledgement', async step => {
  const { invoke, owner, rpc } = fixture(), loc = (relPath: string) => ({ ...scoped, relPath });
  const doc = await invoke({ action: 'add', ...loc('old/note.md'), title: 'Stable', content: 'Exactly once' });
  const normal = rpc.getMockImplementation()!; let lose = true;
  rpc.mockImplementation(async value => {
    const result = await normal(value), c = value.command;
    const match = step === 'mkdir' ? c.type === 'host.mkdir' && c.path.endsWith('/new')
      : step === 'copy' ? c.type === 'host.write_file' && c.path.endsWith('/new/note.md')
      : step === 'remove' ? c.type === 'host.remove_path' && c.path.endsWith('/old/note.md')
      : step === 'index' ? c.type === 'host.write_file' && c.path.endsWith('/index.json')
      : c.type === 'host.remove_path' && c.path.endsWith('/library-transaction.json');
    if (lose && match) { lose = false; throw new Error('lost acknowledgement'); }
    return result;
  });
  await expect(invoke({ action: 'move', from: loc('old'), to: loc('new') })).rejects.toThrow('lost acknowledgement');
  expect((await invoke({ action: 'list' })).find((row: any) => row.id === doc.id)).toMatchObject({ relPath: 'new/note.md' });
  expect(readFileSync(join(owner, '.zcc/library/new/note.md'), 'utf8')).toBe('Exactly once');
  expect(existsSync(join(owner, '.zcc/library/old'))).toBe(false);
  expect(existsSync(join(owner, '.zcc/library-transaction.json'))).toBe(false);
  expect(rpc.mock.calls.filter(([v]) => v.command.type === 'host.write_file' && v.command.path.endsWith('/new/note.md'))).toHaveLength(1);
});

it('rejects tree overlap, collisions and missing sources before mutation', async () => {
  const { invoke, owner } = fixture(), loc = (relPath: string) => ({ ...scoped, relPath });
  await invoke({ action: 'add', ...loc('old/note.md'), title: 'Original', content: 'Preserved' });
  await invoke({ action: 'createFolder', ...loc('taken') });
  for (const to of [loc('old'), loc('old/child'), loc('taken')]) await expect(invoke({ action: 'move', from: loc('old'), to })).rejects.toThrow();
  await expect(invoke({ action: 'deleteEntry', ...loc('missing') })).rejects.toThrow('no longer');
  expect(readFileSync(join(owner, '.zcc/library/old/note.md'), 'utf8')).toBe('Preserved');
  expect(existsSync(join(owner, '.zcc/library-transaction.json'))).toBe(false);
});

it.each(['source', 'destination', 'new-child', 'metadata'])('preserves external %s changes and the pending journal instead of sweeping them away', async changed => {
  const { invoke, owner, rpc } = fixture(), loc = (relPath: string) => ({ ...scoped, relPath });
  await invoke({ action: 'add', ...loc('old/note.md'), title: 'Original', content: 'Original' });
  const normal = rpc.getMockImplementation()!; let inject = true;
  rpc.mockImplementation(async value => {
    const result = await normal(value);
    if (inject && value.command.type === 'host.write_file' && value.command.path.endsWith('/library-transaction.json')) {
      inject = false;
      if (changed === 'metadata') {
        const path = join(owner, '.zcc/library/index.json'), index = JSON.parse(readFileSync(path, 'utf8'));
        index.docs[0].title = 'External title'; writeFileSync(path, JSON.stringify(index));
      } else if (changed === 'destination') { mkdirSync(join(owner, '.zcc/library/new')); writeFileSync(join(owner, '.zcc/library/new/note.md'), 'External'); }
      else writeFileSync(join(owner, `.zcc/library/old/${changed === 'source' ? 'note.md' : 'extra.md'}`), 'External');
    }
    return result;
  });
  await expect(invoke({ action: 'move', from: loc('old'), to: loc('new') })).rejects.toThrow(/changed/);
  expect(existsSync(join(owner, '.zcc/library-transaction.json'))).toBe(true);
  const path = changed === 'metadata' ? 'index.json' : changed === 'destination' ? 'new/note.md' : `old/${changed === 'source' ? 'note.md' : 'extra.md'}`;
  expect(readFileSync(join(owner, '.zcc/library', path), 'utf8')).toContain('External');
});

it('recovers a delete after partial removal and never removes newly added children recursively', async () => {
  const { invoke, owner, rpc } = fixture(), loc = (relPath: string) => ({ ...scoped, relPath });
  await invoke({ action: 'add', ...loc('old/a.md'), title: 'A', content: 'A' });
  await invoke({ action: 'add', ...loc('old/b.md'), title: 'B', content: 'B' });
  const normal = rpc.getMockImplementation()!; let lose = true;
  rpc.mockImplementation(async value => { const result = await normal(value); if (lose && value.command.type === 'host.remove_path') { lose = false; throw new Error('lost reply'); } return result; });
  await expect(invoke({ action: 'deleteEntry', ...loc('old') })).rejects.toThrow('lost reply');
  expect(await invoke({ action: 'list' })).toEqual([]);
  expect(existsSync(join(owner, '.zcc/library/old'))).toBe(false);
  await invoke({ action: 'add', ...loc('other/a.md'), title: 'A', content: 'A' });
  rpc.mockImplementation(async value => {
    if (value.command.type === 'host.remove_path' && value.command.path.endsWith('/other')) writeFileSync(join(owner, '.zcc/library/other/new.md'), 'New file');
    return normal(value);
  });
  await expect(invoke({ action: 'deleteEntry', ...loc('other') })).rejects.toThrow();
  expect(readFileSync(join(owner, '.zcc/library/other/new.md'), 'utf8')).toBe('New file');
});

it('refuses an exclusive-copy race without replacing the destination or deleting the source', async () => {
  const { invoke, owner, rpc } = fixture(), loc = (relPath: string) => ({ ...scoped, relPath });
  await invoke({ action: 'add', ...loc('old.md'), title: 'Original', content: 'Original' });
  const normal = rpc.getMockImplementation()!;
  rpc.mockImplementation(async value => {
    if (value.command.type === 'host.write_file' && value.command.path.endsWith('/new.md')) writeFileSync(join(owner, '.zcc/library/new.md'), 'Other document');
    return normal(value);
  });
  await expect(invoke({ action: 'move', from: loc('old.md'), to: loc('new.md') })).rejects.toThrow('existing bytes were preserved');
  expect(readFileSync(join(owner, '.zcc/library/new.md'), 'utf8')).toBe('Other document');
  expect(readFileSync(join(owner, '.zcc/library/old.md'), 'utf8')).toBe('Original');
});

it('stops a tree operation when its aggregate deadline expires before the next host command', async () => {
  const { invoke, owner, rpc } = fixture(), loc = (relPath: string) => ({ ...scoped, relPath });
  await invoke({ action: 'add', ...loc('old.md'), title: 'Original', content: 'Original' });
  const normal = rpc.getMockImplementation()!;
  rpc.mockImplementation(async value => {
    const result = await normal(value);
    if (value.command.type === 'host.write_file' && value.command.path.endsWith('/library-transaction.json')) vi.spyOn(Date, 'now').mockReturnValue(10 ** 15);
    return result;
  });
  try {
    await expect(invoke({ action: 'deleteEntry', ...loc('old.md') })).rejects.toThrow('timed out');
    expect(readFileSync(join(owner, '.zcc/library/old.md'), 'utf8')).toBe('Original');
    expect(existsSync(join(owner, '.zcc/library-transaction.json'))).toBe(true);
  } finally { vi.restoreAllMocks(); }
});
