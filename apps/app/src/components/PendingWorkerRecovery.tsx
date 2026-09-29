import { useEffect, useRef, useState } from 'react';
import { product } from '../lib/product-client.js';

/** Recovery is an inventory check on the authority, never another launch. */
export function PendingWorkerRecovery({ kind, id, sessionIds }: { kind: 'goal' | 'schedule'; id: string; sessionIds: string[] }) {
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const active = useRef(false), generation = useRef(0);
  useEffect(() => { active.current = false; setBusy(false); setMessage(''); return () => { generation.current++; }; }, [id, kind]);
  async function check() {
    if (active.current) return;
    active.current = true; setBusy(true); setMessage('');
    const current = generation.current;
    try {
      const result = await (kind === 'goal' ? product.goals : product.scheduler).reconcile(id);
      if (current !== generation.current) return;
      setMessage(!result.ok ? result.message : result.value
        ? 'Worker checked. Work remains paused until you resume it.'
        : 'The worker is still unconfirmed. Reconnect its machine and check again. Work remains paused.');
    } catch {
      if (current === generation.current) setMessage('Could not reach the shared instance. Reconnect and check again.');
    } finally {
      if (current === generation.current) { active.current = false; setBusy(false); }
    }
  }
  return <aside className="scheduler-banner-info" role="status" data-testid="pending-worker-recovery">
    <div>
      <strong>Worker launch needs checking.</strong>{' '}The connection ended before the launch was confirmed. This {kind} stays paused to avoid starting the same work twice.
      {sessionIds.length > 0 && <details><summary>Worker details</summary>{sessionIds.map(sessionId => <div key={sessionId}><code>{sessionId}</code></div>)}</details>}
      <button className="settings-btn" type="button" disabled={busy} onClick={() => void check()}>{busy ? 'Checking…' : 'Check worker'}</button>
      {message && <p>{message}</p>}
    </div>
  </aside>;
}
