import { useLibrary } from '@/store';

export function LibraryAvailability({ projectId, scope }: { projectId?: string; scope?: 'global' | 'project' }) {
  const roots = useLibrary(state => state.roots);
  const error = useLibrary(state => state.error);
  const refresh = useLibrary(state => state.refresh);
  const unavailable = (roots ?? []).filter(root => root.state !== 'ready' && (scope
    ? root.scope === scope && (scope === 'global' || root.projectId === projectId)
    : !projectId || root.scope === 'global' || root.projectId === projectId));
  if (!error && !unavailable.length) return null;
  return <div className="tree-loading" role="status" data-testid={scope ? 'library-document-availability' : 'library-availability'}>
    {error && <p>{error}</p>}
    {unavailable.map(root => <p key={`${root.scope}:${root.projectId ?? ''}`}>
      {root.scope === 'global' ? 'Global Library' : root.projectName ?? 'Project Library'}: {root.state === 'offline'
        ? 'storage machine is offline. Previously loaded documents may be out of date. Reconnect to read or save.'
        : root.state === 'limit' ? 'document listing limit reached.' : 'documents are temporarily unavailable. Check the storage machine and try again.'}
    </p>)}
    <button type="button" className="opener-btn" onClick={() => { void refresh(); }}>Retry Library</button>
  </div>;
}
