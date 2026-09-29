import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { z } from 'zod';
import type { LibraryDoc } from '@zana-ai/zcc-domain/product';
import type { LibraryDocumentRequest } from '@zana-ai/zcc-contracts/library-documents';
import type { ProductHttpContext } from '../../http/product-context.js';
import { authorizedLibraryRoots, type LibraryRoot } from '../../http/library-via-host.js';
import { resolveProjectHost } from '../../http/project-host.js';
import { atomicDurableWrite, durableRemove, hashBytes, readRawFile } from '../harness-routing/storage.js';
import { BoundedKeyedQueue } from '../bounded-keyed-queue.js';
import { withProjectLibraries } from './project-library-queue.js';
import { libraryRootIo } from './library-root-io.js';
import { recoverRemoteLibraryTransaction, type LibraryTransactionIo } from './remote-library-transaction.js';
import { assertLibraryTreeSubset, libraryTreeManifest, parseLibraryTreeJournal } from './library-tree-transaction.js';

type Move = Extract<LibraryDocumentRequest, { action: 'move' }>;
const transfers = new BoundedKeyedQueue(4, 100, 'Too many pending Library transfers');
const INDEX = '.zcc/library/index.json', MARKER = '.zcc/library-transaction.json';
const Binding = z.object({ scope: z.enum(['global', 'project']), projectId: z.string().optional(), hostId: z.string(), anchor: z.string(), prefix: z.string() }).strict();
const Journal = z.object({ version: z.literal(1), id: z.string().uuid(), source: Binding, destination: Binding,
  tree: z.string().max(2 * 1024 * 1024), phase: z.enum(['copying', 'complete']) }).strict();
type Journal = z.infer<typeof Journal>;
const under = (path: string, root: string) => path === root || path.startsWith(root + '/');
const ordered = <T extends { relPath: string }>(rows: T[]) => [...rows].sort((a, b) => a.relPath.localeCompare(b.relPath));
const equal = (a: { relPath: string }[], b: { relPath: string }[]) => same(ordered(a), ordered(b));
const at = (path: string, rel: string) => rel ? `${path}/${rel}` : path;
const bind = (ctx: ProductHttpContext, root: LibraryRoot) => ({ scope: root.scope, ...(root.projectId ? { projectId: root.projectId } : {}),
  hostId: resolveProjectHost(ctx, root.hostId), anchor: root.anchor, prefix: root.prefix });

function resolve(ctx: ProductHttpContext, binding: z.infer<typeof Binding>): LibraryRoot {
  const root = authorizedLibraryRoots(ctx).find(row => row.scope === binding.scope && row.projectId === binding.projectId);
  if (!root || !same(bind(ctx, root), binding)) throw new Error('Library transfer owner changed; existing files were preserved');
  return root;
}
function readJournal(path: string): Buffer | null {
  try { if (statSync(path).size > 3 * 1024 * 1024) throw new Error('Library transfer journal is too large'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  return readRawFile(path);
}
async function updateIndex(io: LibraryTransactionIo, path: string, before: LibraryDoc[], after: LibraryDoc[]) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = await io.read(INDEX), next = libraryTreeManifest(raw), affected = next.docs.filter(row => under(row.relPath, path));
    if (equal(affected, after)) return;
    if (!equal(affected, before)) throw new Error('Library transfer metadata changed; recovery and current files were preserved');
    const others = next.docs.filter(row => !under(row.relPath, path));
    if (others.length + after.length > 10_000 || after.some(row => others.some(other => other.id === row.id))) throw new Error('Library destination identity or document limit conflict');
    next.docs = [...others, ...after];
    try { await io.write(INDEX, JSON.stringify(next), raw); return; }
    catch (error) { if ((error as { code?: string }).code !== 'library_conflict' || attempt === 2) throw error; }
  }
}

/** One bounded, durable transfer per instance. Both roots are reserved together.
 * Per-root markers block all other Library writers, including agent tools.
 * The journal stores identities/hashes, never another copy of document bytes.
 * Refresh resumes copying; deletion starts only after destination verification.
 */
export async function maintainLibraryTransfer(ctx: ProductHttpContext, deadline: number, move?: Move): Promise<{ ok: true; path: string } | null> {
  return transfers.run(ctx.dataDir, async () => {
    const path = join(ctx.dataDir, 'library-transfer.json');
    let bytes = readJournal(path), journal: Journal | undefined = bytes ? Journal.parse(JSON.parse(bytes.toString('utf8'))) : undefined;
    const roots = authorizedLibraryRoots(ctx);
    const find = (location: Move['from']) => {
      const root = roots.find(row => row.scope === location.scope && row.projectId === location.projectId);
      if (!root) throw new Error('Library root is not authorized');
      return root;
    };
    if (!journal && !move) return null;
    const source = journal ? resolve(ctx, journal.source) : find(move!.from);
    const destination = journal ? resolve(ctx, journal.destination) : find(move!.to);
    if (source.scope === destination.scope && source.projectId === destination.projectId) throw new Error('Library transfer requires two different roots');
    const sourceBinding = bind(ctx, source), destinationBinding = bind(ctx, destination);
    const src = libraryRootIo(ctx, sourceBinding.hostId, source, deadline), dst = libraryRootIo(ctx, destinationBinding.hostId, destination, deadline);
    return withProjectLibraries([source, destination].map(root => `${ctx.dataDir}:${root.projectId ?? 'global'}`), async () => {
      if (!journal) {
        for (const io of [src, dst]) await recoverRemoteLibraryTransaction(io);
        const entries = await src.tree!.snapshot(move!.from.relPath);
        if (!entries) throw new Error('Library source no longer exists');
        if (entries.reduce((sum, entry) => sum + (entry.kind === 'file' ? entry.sizeBytes : 0), 0) > 64 * 1024 * 1024) throw new Error('Library transfer exceeds 64 MiB');
        if (await dst.tree!.snapshot(move!.to.relPath)) throw new Error('Library destination already exists');
        const beforeEntries = libraryTreeManifest(await src.read(INDEX)).docs.filter(row => under(row.relPath, move!.from.relPath));
        const target = libraryTreeManifest(await dst.read(INDEX));
        if (target.docs.some(row => under(row.relPath, move!.to.relPath) || beforeEntries.some(other => other.id === row.id))) throw new Error('Library destination metadata already exists');
        if (target.docs.length + beforeEntries.length > 10_000) throw new Error('Library manifest exceeds its document limit');
        const tree = JSON.stringify({ version: 2, from: move!.from.relPath, to: move!.to.relPath, entries, beforeEntries,
          afterEntries: beforeEntries.map(row => ({ ...row, relPath: move!.to.relPath + row.relPath.slice(move!.from.relPath.length) })) });
        parseLibraryTreeJournal(tree, true);
        journal = { version: 1, id: randomUUID(), source: sourceBinding, destination: destinationBinding, tree, phase: 'copying' };
        bytes = Buffer.from(JSON.stringify(journal));
        // The embedded tree is JSON-escaped again in the outer journal. Bound
        // the actual persisted bytes too, with room for the completion phase.
        if (bytes.length > 3 * 1024 * 1024 - 64) throw new Error('Library transfer journal is too large');
        atomicDurableWrite(path, bytes, { expectedHash: null });
      }
      const pending = parseLibraryTreeJournal(journal.tree, true);
      if (!pending.to) throw new Error('Invalid Library transfer destination');
      const matchesRequest = !move || (move.from.scope === source.scope && move.from.projectId === source.projectId && move.from.relPath === pending.from
        && move.to.scope === destination.scope && move.to.projectId === destination.projectId && move.to.relPath === pending.to);
      const marker = JSON.stringify({ version: 3, transferId: journal.id });
      if (journal.phase === 'copying') {
        for (const io of [src, dst]) {
          const current = await io.read(MARKER);
          if (current !== marker) {
            if (current !== null) throw new Error('Another Library operation needs recovery before this transfer');
            await io.write(MARKER, marker, null);
          }
        }
        let original = await src.tree!.snapshot(pending.from);
        assertLibraryTreeSubset(original, pending.entries);
        const target = await dst.tree!.snapshot(pending.to);
        assertLibraryTreeSubset(target, pending.entries);
        const before = libraryTreeManifest(await src.read(INDEX)).docs.filter(row => under(row.relPath, pending.from));
        if (!equal(before, pending.beforeEntries) && !(original === null && !before.length)) throw new Error('Library source metadata changed; originals were preserved');
        for (const entry of pending.entries.filter(row => row.kind === 'dir').sort((a, b) => a.relPath.length - b.relPath.length)) await dst.tree!.mkdir(at(pending.to, entry.relPath));
        for (const entry of pending.entries) {
          if (entry.kind !== 'file' || target?.some(row => row.relPath === entry.relPath)) continue;
          const body = await src.tree!.read(at(pending.from, entry.relPath));
          if (body.sha256 !== entry.sha256 || body.sizeBytes !== entry.sizeBytes) throw new Error('Library source changed before copying; originals were preserved');
          await dst.tree!.create(at(pending.to, entry.relPath), body);
        }
        if (!equal((await dst.tree!.snapshot(pending.to)) ?? [], pending.entries)) throw new Error('Library destination verification failed; originals were preserved');
        await updateIndex(dst, pending.to, [], pending.afterEntries as LibraryDoc[]);
        original = await src.tree!.snapshot(pending.from); assertLibraryTreeSubset(original, pending.entries);
        const currentMetadata = libraryTreeManifest(await src.read(INDEX)).docs.filter(row => under(row.relPath, pending.from));
        if (!equal(currentMetadata, pending.beforeEntries) && !(original === null && !currentMetadata.length)) throw new Error('Library source metadata changed; originals were preserved');
        for (const entry of [...(original ?? [])].sort((a, b) => b.relPath.length - a.relPath.length)) await src.tree!.remove(at(pending.from, entry.relPath), entry.kind === 'file' ? entry.sha256 : undefined);
        await updateIndex(src, pending.from, pending.beforeEntries as LibraryDoc[], []);
        journal.phase = 'complete';
        const next = Buffer.from(JSON.stringify(journal)); atomicDurableWrite(path, next, { expectedHash: hashBytes(bytes!) }); bytes = next;
      }
      for (const io of [src, dst]) {
        const current = await io.read(MARKER);
        if (current === marker) await io.remove(MARKER, marker);
        else if (current !== null) throw new Error('Library recovery marker changed');
      }
      durableRemove(path, { expectedHash: hashBytes(bytes!) });
      for (const root of [source, destination]) ctx.hub.emit('library:changed', { projectId: root.projectId });
      if (!matchesRequest) throw new Error('The previous Library transfer finished. Retry this move.');
      return { ok: true, path: posix.join(destination.root, pending.to) };
    });
  });
}
