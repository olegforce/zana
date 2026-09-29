import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { HostTreeEntrySchema, type HostTreeEntry, type HostReadPathResult } from '@zana-ai/zcc-contracts/host-rpc';
import type { LibraryDoc } from '@zana-ai/zcc-domain/product';
import type { LibraryTransactionIo } from './remote-library-transaction.js';

const JOURNAL = '.zcc/library-transaction.json', INDEX = '.zcc/library/index.json';
const Path = z.string().min(1).max(4096).refine(value => !/[\\\x00-\x1f]/.test(value) && !/^[a-zA-Z]:/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..'));
const RootEntryPath = Path.refine(value => value !== 'index.json');
const Entry = z.object({ id: z.string().min(1), relPath: RootEntryPath, title: z.string(), kind: z.enum(['md', 'pdf', 'image', 'code', 'other']), createdAt: z.number(), updatedAt: z.number() }).passthrough();
const Journal = z.object({ version: z.literal(2), from: RootEntryPath, to: RootEntryPath.nullable(),
  entries: z.array(HostTreeEntrySchema).min(1).max(1000),
  beforeEntries: z.array(Entry).max(10_000), afterEntries: z.array(Entry).max(10_000)
}).strict();
type Journal = z.infer<typeof Journal>;
export interface LibraryTreeIo {
  snapshot(path: string): Promise<HostTreeEntry[] | null>;
  read(path: string): Promise<HostReadPathResult>;
  create(path: string, body: HostReadPathResult): Promise<void>;
  mkdir(path: string): Promise<void>;
  remove(path: string, sha256?: string): Promise<void>;
}
const under = (path: string, root: string) => path === root || path.startsWith(root + '/');
const at = (base: string, rel: string) => rel ? `${base}/${rel}` : base;
const same = isDeepStrictEqual;
const ordered = (rows: { relPath: string }[]) => [...rows].sort((a, b) => a.relPath.localeCompare(b.relPath));
function tree(io: LibraryTransactionIo): LibraryTreeIo { if (!io.tree) throw new Error('Library tree operations are unavailable'); return io.tree; }
export function parseLibraryTreeJournal(raw: string, differentRoots = false): Journal {
  if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw new Error('Library tree journal is too large');
  const journal = Journal.parse(JSON.parse(raw));
  const paths = new Map(journal.entries.map(row => [row.relPath, row]));
  if (!paths.has('') || paths.size !== journal.entries.length || journal.entries.some(row => row.relPath !== '' && !Path.safeParse(row.relPath).success)
    || (paths.get('')!.kind === 'file' && paths.size !== 1)
    || journal.entries.some(row => row.relPath && paths.get(row.relPath.split('/').slice(0, -1).join('/'))?.kind !== 'dir')
    || (!differentRoots && journal.to && (under(journal.to, journal.from) || under(journal.from, journal.to)))
    || journal.beforeEntries.some(row => !under(row.relPath, journal.from))
    || !same(journal.afterEntries, journal.to ? journal.beforeEntries.map(row => ({ ...row, relPath: journal.to + row.relPath.slice(journal.from.length) })) : [])) throw new Error('Invalid library tree journal');
  return journal;
}
export function libraryTreeManifest(raw: string | null): { version: 1; docs: LibraryDoc[] } {
  const value = raw === null ? { version: 1, docs: [] } : JSON.parse(raw);
  if (value?.version !== 1 || !Array.isArray(value.docs) || value.docs.length > 10_000 || value.docs.some((row: unknown) => !Entry.safeParse(row).success)
    || new Set(value.docs.map((row: LibraryDoc) => row.relPath)).size !== value.docs.length) throw new Error('Invalid library manifest');
  return value;
}
export function assertLibraryTreeSubset(current: HostTreeEntry[] | null, expected: HostTreeEntry[]): void {
  const byPath = new Map(expected.map(row => [row.relPath, row]));
  if (current?.some(row => !same(row, byPath.get(row.relPath)))) throw new Error('Library tree changed; current files and the recovery journal were preserved');
}

/** Resume only the requested move/delete. Copies use exclusive creation and
 * sources are revision-checked; a directory is removed only while empty. A new
 * or edited file stops recovery instead of being swept up by recursive removal.
 * Source bytes are retained until the complete destination has been verified.
 */
export async function recoverLibraryTreeTransaction(io: LibraryTransactionIo, raw: string): Promise<boolean> {
  const pending = parseLibraryTreeJournal(raw), fs = tree(io);
  let source = await fs.snapshot(pending.from);
  assertLibraryTreeSubset(source, pending.entries);
  if (pending.to) {
    const destination = await fs.snapshot(pending.to);
    assertLibraryTreeSubset(destination, pending.entries);
    for (const entry of pending.entries.filter(row => row.kind === 'dir').sort((a, b) => a.relPath.length - b.relPath.length)) await fs.mkdir(at(pending.to, entry.relPath));
    for (const entry of pending.entries) {
      if (entry.kind !== 'file' || destination?.some(row => row.relPath === entry.relPath)) continue;
      const body = await fs.read(at(pending.from, entry.relPath));
      if (body.sha256 !== entry.sha256 || body.sizeBytes !== entry.sizeBytes) throw new Error('Library source changed before copying; original bytes were preserved');
      await fs.create(at(pending.to, entry.relPath), body);
    }
    if (!same(ordered((await fs.snapshot(pending.to)) ?? []), ordered(pending.entries))) throw new Error('Library destination verification failed; source bytes were preserved');
    source = await fs.snapshot(pending.from);
    assertLibraryTreeSubset(source, pending.entries);
  }
  // Do not replay a recursive delete. New children make rmdir fail safely.
  for (const entry of [...(source ?? [])].sort((a, b) => b.relPath.length - a.relPath.length)) await fs.remove(at(pending.from, entry.relPath), entry.kind === 'file' ? entry.sha256 : undefined);
  for (let attempt = 0; attempt < 3; attempt++) {
    const previous = await io.read(INDEX), next = libraryTreeManifest(previous);
    const affected = next.docs.filter(row => under(row.relPath, pending.from) || (!!pending.to && under(row.relPath, pending.to)));
    if (same(ordered(affected), ordered(pending.afterEntries))) break;
    if (!same(ordered(affected), ordered(pending.beforeEntries))) throw new Error('Library metadata changed during recovery; the journal was preserved');
    next.docs = [...next.docs.filter(row => !under(row.relPath, pending.from)), ...pending.afterEntries as LibraryDoc[]];
    try { await io.write(INDEX, JSON.stringify(next), previous); break; }
    catch (error) { if ((error as { code?: string }).code !== 'library_conflict' || attempt === 2) throw error; }
  }
  await io.remove(JOURNAL, raw);
  return true;
}

export async function commitLibraryTreeTransaction(io: LibraryTransactionIo, from: string, to: string | null): Promise<void> {
  RootEntryPath.parse(from); if (to !== null) RootEntryPath.parse(to);
  if (to && (under(to, from) || under(from, to))) throw new Error('Library source and destination overlap');
  const fs = tree(io), entries = await fs.snapshot(from);
  if (!entries) throw new Error('Library source no longer exists');
  if (to && await fs.snapshot(to)) throw new Error('Library destination already exists');
  const index = libraryTreeManifest(await io.read(INDEX));
  if (to && index.docs.some(row => under(row.relPath, to))) throw new Error('Library destination metadata already exists');
  const beforeEntries = index.docs.filter(row => under(row.relPath, from));
  const raw = JSON.stringify({ version: 2, from, to, entries, beforeEntries,
    afterEntries: to ? beforeEntries.map(row => ({ ...row, relPath: to + row.relPath.slice(from.length) })) : [] });
  parseLibraryTreeJournal(raw);
  await io.write(JOURNAL, raw, null);
  await recoverLibraryTreeTransaction(io, raw);
}
