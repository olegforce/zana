'use client';
import { useEffect, useState } from 'react';
import styles from './connect.module.css';
interface Machine { id: string; name: string; revoked: boolean }
export function InstanceMachines({ serverId, api, refreshRevision }: { serverId: string; api(path: string): Promise<{ machines: Machine[] }>; refreshRevision: number }) {
  const [open, setOpen] = useState(false);
  const [machines, setMachines] = useState<Machine[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    let active = true;
    setBusy(true); setError('');
    void api(`/account/hosts?serverId=${encodeURIComponent(serverId)}`)
      .then(result => { if (active) setMachines(result.machines); })
      .catch(error => { if (active) setError(error instanceof Error ? error.message : 'Could not load execution machines'); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [serverId, api, open, refreshRevision]);
  return <details className={styles.machines} open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Execution machines</summary>
    {busy && <p role="status">Loading machines…</p>}
    {machines && (machines.some(machine => !machine.revoked)
      ? <ul className={styles.machinesList}>{machines.filter(machine => !machine.revoked).map(machine => <li key={machine.id}>{machine.name} · Enrolled</li>)}</ul>
      : <p>No additional machines enrolled yet.</p>)}
    {machines && <p>Add, repair or remove machines in this Zana’s Settings → Machines. They share this instance’s address, projects and history.</p>}
    {error && <p role="alert">{error}. Use Refresh above to try again.</p>}
  </details>;
}
