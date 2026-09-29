import { createHash } from 'node:crypto';
import type { LibraryDoc, LibraryManifest } from '@zana-ai/zcc-domain/product';
import { recoverLibraryTreeTransaction, type LibraryTreeIo } from './library-tree-transaction.js';

/** One serialized, recoverable document/index operation on the fixed owner.
 * Every individual replacement is atomic and conditional. The journal holds
 * metadata and hashes, never another copy of document content. A crash can leave
 * it pending; the next operation verifies the bytes before completing the index.
 */
export interface LibraryTransactionIo {
  tree?: LibraryTreeIo;
  /** Hash document bytes without requiring UTF-8 (journals/indexes remain text). */
  documentHash?(path: string): Promise<string | null>;
  read(path: string): Promise<string | null>;
  write(path: string, content: string, previous: string | null): Promise<void>;
  remove(path: string, previous: string): Promise<void>;
}
const JOURNAL = '.zcc/library-transaction.json';
const INDEX = '.zcc/library/index.json';
interface Journal {
  version: 1;
  relPath: string;
  beforeHash: string | null;
  afterHash: string | null;
  beforeEntry: LibraryDoc | null;
  afterEntry: LibraryDoc | null;
}
const hash = (text: string | null) => text === null ? null : createHash('sha256').update(text).digest('hex');
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
function manifest(text: string | null): LibraryManifest {
  const value = text === null ? { version: 1, docs: [] } : JSON.parse(text);
  if (!value || value.version !== 1 || !Array.isArray(value.docs) || value.docs.length > 10_000
    || value.docs.some((doc: unknown) => !doc || typeof doc !== 'object' || typeof (doc as LibraryDoc).relPath !== 'string')) throw new Error('Invalid library manifest');
  return value;
}
function parseJournal(raw: string): Journal {
  if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw new Error('Library transaction journal is too large');
  const value = JSON.parse(raw) as Journal;
  if (!value || value.version !== 1 || typeof value.relPath !== 'string'
    || value.relPath.length > 4096 || /[\\\x00-\x1f]/.test(value.relPath)
    || value.relPath.split('/').some(part => !part || part === '.' || part === '..')
    || value.relPath === 'index.json'
    || ![value.beforeHash, value.afterHash].every(v => v === null || (typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)))
    || ![value.beforeEntry, value.afterEntry].every(v => v === null || (typeof v === 'object' && v.relPath === value.relPath && typeof v.id === 'string'))
    || (value.afterEntry === null) !== (value.afterHash === null)) throw new Error('Invalid library transaction journal');
  return value;
}

export async function recoverRemoteLibraryTransaction(io: LibraryTransactionIo): Promise<boolean> {
  const raw = await io.read(JOURNAL);
  if (raw === null) return false;
  if (Buffer.byteLength(raw) <= 2 * 1024 * 1024 && JSON.parse(raw)?.version === 3) throw new Error('Library transfer is pending. Reconnect both machines and refresh Library to recover it.');
  if (Buffer.byteLength(raw) <= 2 * 1024 * 1024 && JSON.parse(raw)?.version === 2) return recoverLibraryTreeTransaction(io, raw);
  const pending = parseJournal(raw);
  const path = `.zcc/library/${pending.relPath}`;
  const currentHash = io.documentHash ? await io.documentHash(path) : hash(await io.read(path));
  if (currentHash !== pending.afterHash) {
    // No document commit, or an external edit won. Never replay a file write.
    await io.remove(JOURNAL, raw);
    if (currentHash !== pending.beforeHash) throw new Error('Library document changed during recovery; its current content was preserved. Read it again before retrying.');
    return false;
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const previous = await io.read(INDEX), next = manifest(previous);
    const entry = next.docs.find(doc => doc.relPath === pending.relPath) ?? null;
    if (same(entry, pending.afterEntry)) break; // Lost acknowledgement after commit.
    if (!same(entry, pending.beforeEntry)) throw new Error('Library index changed during recovery; pending document metadata was preserved for review');
    next.docs = next.docs.filter(doc => doc.relPath !== pending.relPath);
    if (pending.afterEntry) next.docs.push(pending.afterEntry);
    if (next.docs.length > 10_000) throw new Error('Library manifest exceeds its document limit');
    try { await io.write(INDEX, JSON.stringify(next), previous); break; }
    catch (error) {
      if ((error as { code?: string }).code !== 'library_conflict' || attempt === 2) throw error;
    }
  }
  await io.remove(JOURNAL, raw);
  return true;
}

export async function commitRemoteLibraryTransaction(io: LibraryTransactionIo, input: {
  relPath: string; before: string | null; after: string | null;
  beforeEntry: LibraryDoc | null; afterEntry: LibraryDoc | null;
}): Promise<void> {
  const pending: Journal = { version: 1, relPath: input.relPath, beforeHash: hash(input.before), afterHash: hash(input.after), beforeEntry: input.beforeEntry, afterEntry: input.afterEntry };
  const raw = JSON.stringify(pending);
  parseJournal(raw);
  await io.write(JOURNAL, raw, null);
  const path = `.zcc/library/${input.relPath}`;
  if (input.after === null) {
    if (input.before !== null) await io.remove(path, input.before);
  } else await io.write(path, input.after, input.before);
  await recoverRemoteLibraryTransaction(io);
}

/** Import is create-only. The existing journal records hashes and metadata, not
 * uploaded content, and recovery never replays an unacknowledged file write. */
export async function commitLibraryImport(io: LibraryTransactionIo, relPath: string, bytes: Buffer, entry: LibraryDoc): Promise<void> {
  if (!io.tree || !io.documentHash) throw new Error('Library import is unavailable');
  if (await io.documentHash(`.zcc/library/${relPath}`) !== null) throw new Error('Library document already exists');
  const pending: Journal = { version: 1, relPath, beforeHash: null, afterHash: createHash('sha256').update(bytes).digest('hex'), beforeEntry: null, afterEntry: entry };
  const raw = JSON.stringify(pending); parseJournal(raw);
  await io.write(JOURNAL, raw, null);
  await io.tree.create(relPath, { path: relPath, content: bytes.toString('base64'), contentEncoding: 'base64', sizeBytes: bytes.length, sha256: pending.afterHash! });
  await recoverRemoteLibraryTransaction(io);
}
