import type { ProductHttpContext } from '../../http/product-context.js';
import type { LibraryRoot } from '../../http/library-via-host.js';
import type { LibraryTransactionIo } from './remote-library-transaction.js';
import { remoteLibraryIo } from './remote-library-io.js';

/** Reuse the project transaction format for the instance's global library. */
export function libraryRootIo(ctx: ProductHttpContext, hostId: string, root: LibraryRoot, deadline = Date.now() + 15_000): LibraryTransactionIo {
  const io = remoteLibraryIo(ctx, hostId, root.anchor, deadline, root.prefix);
  const path = (value: string) => root.scope === 'global' ? value.replace(/^\.zcc\//, '') : value;
  return { tree: io.tree, documentHash: value => io.documentHash!(path(value)), read: value => io.read(path(value)), write: (value, content, previous) => io.write(path(value), content, previous), remove: (value, previous) => io.remove(path(value), previous) };
}
