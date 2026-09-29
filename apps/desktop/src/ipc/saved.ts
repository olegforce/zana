// @ts-nocheck
import { ipcMain } from 'electron';
import { LibraryDocumentRequestSchema } from '@zana-ai/zcc-contracts/library-documents';
import { IPC } from '@zana-ai/zcc-desktop-contract';
import { ctx } from './ctx.js';
import type { LibraryAddInput, LibraryDoc, LibraryScope, SavedRecord, SavedRecordInput } from '@zana-ai/zcc-domain/product';

export function registerSavedIpc(): void {
  

  // Saved reports: save/list/delete RPCs + full-list change pushes. The save
  // onError returns null so a failed write surfaces as a toast in the renderer
  // rather than throwing across IPC (the bridge type is SavedRecord | null).
  ctx.safeHandle(
    IPC.saved.save,
    (input: SavedRecordInput) => ctx.savedStore.save(input),
    () => null
  );
  ctx.safeHandle(IPC.saved.list, () => ctx.savedStore.list(), () => []);
  ctx.safeHandle(
    IPC.saved.delete,
    (id: string) => ctx.savedStore.delete(id),
    () => false
  );
  ctx.savedStore.onChanged((records: SavedRecord[]) => {
    ctx.safeSend(IPC.saved.onChanged, records);
  });

  const document = (request: unknown) => {
    const checked = LibraryDocumentRequestSchema.parse(request);
    if (!ctx.runtimeSupervisor) throw new Error('Library runtime is unavailable');
    return ctx.runtimeSupervisor.libraryDocument(checked);
  };

  // Library: main validates, then the selected product runtime resolves ownership.
  ipcMain.handle(IPC.library.list, () => document({ action: 'list' }));
  // Reject unavailable runtime reads; never represent a failed snapshot as an empty Library.
  ipcMain.handle(IPC.library.snapshot, () => document({ action: 'snapshot' }));
  ipcMain.handle(IPC.library.importFile, (_event, input: import('@zana-ai/zcc-domain/product').LibraryImportInput) => document({ ...input, action: 'import' }));
  ctx.safeHandle(IPC.library.readAsset, (scope: LibraryScope, relPath: string, projectId?: string) => document({ action: 'asset', scope, relPath, projectId }), () => ({ ok: false, message: 'Library preview is unavailable' }));
  ctx.safeHandle(
    IPC.library.add,
    (input: LibraryAddInput) => { const { source: _source, ...fields } = input; return document({ action: 'add', ...fields }); },
    () => null
  );
  ctx.safeHandle(
    IPC.library.update,
    (id: string, patch: Partial<Pick<LibraryDoc, 'title' | 'summary' | 'tags'>>, location?: import('@zana-ai/zcc-domain/product').LibraryDocLocation) =>
      document({ action: 'update', id, patch, location }),
    () => null
  );
  ctx.safeHandle(
    IPC.library.remove,
    (id: string, location?: import('@zana-ai/zcc-domain/product').LibraryDocLocation) => document({ action: 'remove', id, location }),
    () => false
  );
  ctx.safeHandle(
    IPC.library.reveal,
    (scope: LibraryScope, projectId?: string) => ctx.libraryStore.revealDir(scope, projectId),
    () => ({ ok: false, path: '', message: 'Reveal failed' })
  );
  ctx.safeHandle(
    IPC.library.search,
    (query: string) => document({ action: 'search', query }),
    () => ({ hits: [], truncated: false })
  );
  // Read/write a library doc's content by SCOPE + relPath (not an absolute
  // path). Global docs live in `~/.zcc/library`, outside any registered project,
  // so the generic project-confined fs.readFile/writeFile rejects them; these
  // seams confine to the scope's own library dir instead (CLAUDE.md #1/#2 — main
  // resolves the trusted dir from the scope, the renderer never passes an abspath).
  ctx.safeHandle(
    IPC.library.read,
    (scope: LibraryScope, relPath: string, projectId?: string) =>
      document({ action: 'read', scope, relPath, projectId }),
    () => ({ ok: false, message: 'Read failed' })
  );
  ctx.safeHandle(
    IPC.library.write,
    (scope: LibraryScope, relPath: string, content: string, projectId?: string, expectedSha256?: string) =>
      document({ action: 'write', scope, relPath, content, projectId, expectedSha256 }),
    () => ({ ok: false, message: 'Write failed' })
  );
  // Folder-tree CRUD (createFolder/move/delete) — the full-library explorer's
  // New folder / rename-move / delete actions. Same scope-confined trust model
  // as read/write above.
  ctx.safeHandle(
    IPC.library.createFolder,
    (scope: LibraryScope, relPath: string, projectId?: string) =>
      document({ action: 'createFolder', scope, relPath, projectId }),
    () => ({ ok: false, message: 'Create folder failed' })
  );
  ctx.safeHandle(
    IPC.library.move,
    (
      from: { scope: LibraryScope; relPath: string; projectId?: string },
      to: { scope: LibraryScope; relPath: string; projectId?: string }
    ) => document({ action: 'move', from, to }),
    () => ({ ok: false, message: 'Move failed' })
  );
  ctx.safeHandle(
    IPC.library.deleteEntry,
    (scope: LibraryScope, relPath: string, projectId?: string) =>
      document({ action: 'deleteEntry', scope, relPath, projectId }),
    () => ({ ok: false, message: 'Delete failed' })
  );
  ctx.libraryStore.onChanged(() => {
    void ctx.invalidateLibrary();
  });
}
