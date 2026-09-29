import { expect, it, vi } from 'vitest';
import type { LibraryDoc } from '@zana-ai/zcc-domain/product';
import { commitLibraryImport, commitRemoteLibraryTransaction as commit, recoverRemoteLibraryTransaction as recover, type LibraryTransactionIo } from './remote-library-transaction.js';
const INDEX = '.zcc/library/index.json', JOURNAL = '.zcc/library-transaction.json', FILE = '.zcc/library/note.txt';
const doc = (id = 'doc', relPath = 'note.txt'): LibraryDoc => ({ id, relPath, title: 'Shared', kind: 'other', bytes: 3, createdAt: 1, updatedAt: 1, source: { kind: 'agent', projectId: 'p', sessionId: 's' } });
it('refuses binary import without a byte-safe exclusive-create adapter', async () => {
  const { io } = fixture();
  await expect(commitLibraryImport(io, 'note.txt', Buffer.from('new'), doc())).rejects.toThrow('unavailable');
  io.tree = {} as NonNullable<LibraryTransactionIo['tree']>;
  await expect(commitLibraryImport(io, 'note.txt', Buffer.from('new'), doc())).rejects.toThrow('unavailable');
  expect(io.write).not.toHaveBeenCalled();
});
function fixture() {
  const files = new Map<string, string>();
  const io: LibraryTransactionIo = {
    read: vi.fn(async path => files.get(path) ?? null),
    write: vi.fn(async (path, content, previous) => {
      if ((files.get(path) ?? null) !== previous) throw Object.assign(new Error('conflict'), { code: 'library_conflict' });
      files.set(path, content);
    }),
    remove: vi.fn(async (path, previous) => { expect(files.get(path)).toBe(previous); files.delete(path); })
  };
  const input = { relPath: 'note.txt', before: null, after: 'new', beforeEntry: null, afterEntry: doc() };
  return { files, io, input };
}
it('recovers a new non-Markdown document after losing the index acknowledgement without changing its id', async () => {
  const { files, io, input } = fixture(), write = io.write;
  io.write = vi.fn(async (...args) => { await write(...args); if (args[0] === INDEX) throw new Error('lost reply'); });
  await expect(commit(io, input)).rejects.toThrow('lost reply');
  expect(files.get(FILE)).toBe('new'); expect(files.has(JOURNAL)).toBe(true);
  io.write = write;
  await recover(io); await recover(io);
  expect(JSON.parse(files.get(INDEX)!).docs).toEqual([doc()]); expect(files.has(JOURNAL)).toBe(false);
});
it('recovers a document commit when the connection drops before updating the index', async () => {
  const { files, io, input } = fixture(), write = io.write;
  io.write = async (...args) => { await write(...args); if (args[0] === FILE) throw new Error('offline'); };
  await expect(commit(io, input)).rejects.toThrow('offline');
  expect(files.has(INDEX)).toBe(false);
  io.write = write;
  await recover(io);
  expect(JSON.parse(files.get(INDEX)!).docs[0].id).toBe('doc');
});
it('abandons an uncommitted write without replaying document content', async () => {
  const { files, io, input } = fixture(), write = io.write;
  io.write = async (...args) => { if (args[0] === FILE) throw new Error('offline'); await write(...args); };
  await expect(commit(io, input)).rejects.toThrow('offline');
  io.write = write;
  await recover(io);
  expect(files.size).toBe(0);
});
it('preserves an external edit instead of rolling it back or overwriting it', async () => {
  const { files, io, input } = fixture(), write = io.write;
  io.write = async (...args) => { await write(...args); if (args[0] === FILE) throw new Error('offline'); };
  await expect(commit(io, input)).rejects.toThrow();
  files.set(FILE, 'user edit'); io.write = write;
  await expect(recover(io)).rejects.toThrow('current content was preserved');
  expect(files.get(FILE)).toBe('user edit'); expect(files.has(INDEX)).toBe(false); expect(files.has(JOURNAL)).toBe(false);
});
it('recovers removal after a lost acknowledgement and handles missing entries', async () => {
  const { files, io, input } = fixture(); await commit(io, input);
  const remove = io.remove;
  io.remove = async (...args) => { await remove(...args); if (args[0] === FILE) throw new Error('offline'); };
  await expect(commit(io, { ...input, before: 'new', after: null, beforeEntry: doc(), afterEntry: null })).rejects.toThrow();
  io.remove = remove; await recover(io);
  expect(JSON.parse(files.get(INDEX)!).docs).toEqual([]); expect(files.has(FILE)).toBe(false);
  await commit(io, { ...input, before: null, after: null, beforeEntry: null, afterEntry: null });
  expect(files.has(JOURNAL)).toBe(false);
});
it('merges unrelated manifest edits and bounds contention retries', async () => {
  const { files, io, input } = fixture(), write = io.write;
  let conflicts = 0;
  io.write = async (...args) => {
    if (args[0] === INDEX && conflicts++ === 0) files.set(INDEX, JSON.stringify({ version: 1, docs: [doc('other', 'other.md')] }));
    await write(...args);
  };
  await commit(io, input);
  expect(JSON.parse(files.get(INDEX)!).docs.map((d: LibraryDoc) => d.id)).toEqual(['other', 'doc']);
  io.write = async (...args) => { if (args[0] === INDEX) throw Object.assign(new Error('busy'), { code: 'library_conflict' }); await write(...args); };
  await expect(commit(io, { ...input, before: 'new', beforeEntry: doc(), afterEntry: { ...doc(), title: 'Changed' } })).rejects.toThrow('busy');
  expect(files.has(JOURNAL)).toBe(true);
});
it('keeps the recovery journal if another writer changes the same metadata entry', async () => {
  const { files, io, input } = fixture(), write = io.write;
  io.write = async (...args) => { await write(...args); if (args[0] === FILE) files.set(INDEX, JSON.stringify({ version: 1, docs: [{ ...doc(), title: 'User title' }] })); };
  await expect(commit(io, input)).rejects.toThrow('pending document metadata');
  expect(files.has(JOURNAL)).toBe(true); expect(JSON.parse(files.get(INDEX)!).docs[0].title).toBe('User title');
});
it('rejects malformed journals and never uses their paths for file operations', async () => {
  for (const value of ['x', JSON.stringify({ version: 1, relPath: '../escape' }), ' '.repeat(2 * 1024 * 1024 + 1)]) {
    const { files, io } = fixture(); files.set(JOURNAL, value);
    await expect(recover(io)).rejects.toThrow();
    expect(io.read).toHaveBeenCalledTimes(1); expect(io.remove).not.toHaveBeenCalled(); expect(io.write).not.toHaveBeenCalled();
  }
});
it('rejects invalid and over-capacity manifests without deleting the recovery journal', async () => {
  for (const value of [{ docs: [] }, { version: 1, docs: [null] }, { version: 1, docs: Array.from({ length: 10_000 }, (_, i) => doc(String(i), `${i}.txt`)) }]) {
    const { files, io, input } = fixture(); files.set(INDEX, JSON.stringify(value));
    await expect(commit(io, input)).rejects.toThrow(/manifest/);
    expect(files.get(FILE)).toBe('new'); expect(files.has(JOURNAL)).toBe(true);
  }
});
