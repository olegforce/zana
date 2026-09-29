import { useState } from 'react';
import { product } from '../../lib/product-client.js';

export function SharedInstancePicker() {
  const [instances, setInstances] = useState<Awaited<ReturnType<typeof product.sharedClient.list>>>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  async function run(action: () => Promise<unknown>) {
    setBusy(true); setError('');
    try { await action(); } catch (err) { setError(err instanceof Error ? err.message : 'Could not open shared Zana'); }
    finally { setBusy(false); }
  }
  return <section aria-label="Open a shared Zana" className="remote-access-address">
    <h2>Open a shared Zana</h2>
    <p>Sign in to open an existing instance in this desktop app. Its projects, threads and machines stay together at the same address.</p>
    <div className="remote-access-actions">
      <button type="button" className="btn" disabled={busy} onClick={() => void run(async () => {
        setSigningIn(true);
        try { await product.sharedClient.signIn(); setInstances(await product.sharedClient.list()); }
        finally { setSigningIn(false); }
      })}>Sign in</button>
      <button type="button" className="btn" disabled={busy} onClick={() => void run(async () => setInstances(await product.sharedClient.list()))}>Refresh instances</button>
    </div>
    {signingIn && <p role="status">Finish signing in in your browser. Your instances will appear here automatically.</p>}
    {instances.map(instance => <div key={instance.id} className="remote-access-address">
      <strong>{instance.name}</strong><code>{instance.url}</code><span>{instance.online ? 'Online' : 'Offline'}</span>
      <button type="button" className="btn" disabled={busy} onClick={() => void run(() => product.sharedClient.select(instance.id))}>Open instance</button>
    </div>)}
    <p className="settings-help">To also run work on this computer, open Machines in the shared instance and use Add a machine. Opening an instance keeps your local projects and running work intact.</p>
    {error && <p role="alert">{error}</p>}
  </section>;
}
