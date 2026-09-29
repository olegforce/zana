import { useEffect, useState } from 'react';
import type { Project } from '@zana-ai/zcc-domain/product';
import type { ProjectSource } from '@zana-ai/zcc-domain/project';
import { apiJson } from '../../lib/fetch-with-app-surface.js';
import { useHosts } from '../../hooks/useHosts.js';
import { Section } from '../../components/settings/FormFields.js';

export function ProjectSourcesSettings({ project, onSaved }: { project: Project; onSaved(): void }) {
  const hosts = useHosts();
  const [sources, setSources] = useState<ProjectSource[]>([]);
  const [hostId, setHostId] = useState('');
  const [path, setPath] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setSources([]); setError('');
    void apiJson<{ sources: ProjectSource[] }>(`/projects/${encodeURIComponent(project.id)}/sources`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setSources(result.sources); })
      .catch(err => { if (!controller.signal.aborted) setError(err.message); });
    return () => controller.abort();
  }, [project.id, revision]);
  async function mutate(sourceId?: string) {
    setBusy(true); setError('');
    try {
      await apiJson(`/projects/${encodeURIComponent(project.id)}/sources${sourceId ? '/' + encodeURIComponent(sourceId) : ''}`, {
        method: sourceId ? 'DELETE' : 'POST', body: sourceId ? '{}' : JSON.stringify({ hostId, path })
      });
      setPath(''); setHostId(''); setRevision(value => value + 1); onSaved();
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not update checkouts'); }
    finally { setBusy(false); }
  }
  return <Section title="Checkouts on your machines">
    <p className="settings-help">Use this same project on different machines. Each machine keeps its own files and Git changes. Shared history and project settings stay with this Zana instance.</p>
    <ul>{sources.map(source => <li key={source.id}>
      <strong>{hosts.find(host => host.id === source.hostId)?.name ?? 'Offline machine'}</strong> · <code>{source.path}</code>
      {source.id.startsWith('original:') ? <span> · Shared metadata</span> : <button type="button" className="settings-btn" disabled={busy} onClick={() => void mutate(source.id)}>Remove checkout</button>}
    </li>)}</ul>
    <p className="settings-help">Removing a checkout leaves its files and existing threads intact. New work requires a registered checkout.</p>
    <label className="settings-field">Machine<select aria-label="Checkout machine" value={hostId} onChange={event => setHostId(event.target.value)} disabled={busy}>
      <option value="">Choose a machine</option>
      {hosts.filter(host => !sources.some(source => source.hostId === host.id)).map(host => <option key={host.id} value={host.id} disabled={host.status !== 'connected'}>{host.name}{host.status !== 'connected' ? ' (offline)' : ''}</option>)}
    </select></label>
    <label className="settings-field">Existing folder<input aria-label="Checkout folder" value={path} onChange={event => setPath(event.target.value)} placeholder="/home/you/projects/my-project" disabled={busy} /></label>
    <button type="button" className="settings-btn" disabled={busy || !hostId || !path.startsWith('/')} onClick={() => void mutate()}>Add checkout</button>
    {error && <p role="alert">{error}</p>}
  </Section>;
}
