import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ExternalLink } from 'lucide-react';
import { product } from '../../lib/product-client.js';

export function ConnectCodePairing({ onPaired }: { onPaired(): Promise<void> }) {
  const [service, setService] = useState('https://zana-ide.com');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const attempted = useRef('');
  const inFlight = useRef(false);
  const normalized = code.replace(/[\s-]/g, '').toUpperCase();
  const valid = /^[A-F0-9]{16}$/.test(normalized);
  let dashboardUrl = 'https://zana-ide.com/connect/';
  try {
    const url = new URL(service.trim());
    if (url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash) dashboardUrl = `${url.origin}/connect/`;
  } catch { /* Main validates the service before sending a code. */ }
  const connect = async () => {
    if (!valid || inFlight.current) return;
    inFlight.current = true; attempted.current = `${service}:${normalized}`;
    setBusy(true); setError('');
    try {
      await product.mobile.redeemComputerCode(service.trim(), normalized);
      setCode('');
      await onPaired();
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not connect. Get a new code and try again.'); }
    finally { inFlight.current = false; setBusy(false); }
  };
  const connectRef = useRef(connect); connectRef.current = connect;
  useEffect(() => {
    if (!valid || attempted.current === `${service}:${normalized}`) return;
    const timer = setTimeout(() => void connectRef.current(), 350);
    return () => clearTimeout(timer);
  }, [valid, service, normalized]);
  return <div className="remote-access-pairing">
    <p>Pairing gives this computer a private URL like <code>your-name.zana-ide.com</code>. Your projects and agents keep running on this computer.</p>
    <ol className="remote-access-steps">
      <li><span aria-hidden="true">1</span><div><p>Get a one-time connect code from your Zana account.</p>
        <a className="btn primary" href={dashboardUrl} target="_blank" rel="noreferrer">Get a connect code <ExternalLink size={15} aria-hidden="true" /></a>
      </div></li>
      <li><span aria-hidden="true">2</span><div><label htmlFor="remote-connect-code">Paste it here — it connects automatically.</label>
        <form className="remote-access-code-form" onSubmit={event => { event.preventDefault(); void connect(); }}>
          <input id="remote-connect-code" aria-label="Connect code" value={code} maxLength={80} autoComplete="off" spellCheck={false} placeholder="XXXX-XXXX-XXXX-XXXX" disabled={busy} onChange={event => { setCode(event.target.value); setError(''); }} />
          <button type="submit" className="btn primary" disabled={!valid || busy}>{busy ? 'Connecting…' : 'Connect'}</button>
        </form>
      </div></li>
    </ol>
    {error && <p role="alert">{error}</p>}
    <p className="remote-access-notice"><AlertTriangle size={16} aria-hidden="true" />Anyone signed in to your Zana account can control this computer through its remote address.</p>
    <details className="remote-access-advanced"><summary>Advanced connection settings</summary>
      <label className="settings-field">Connect service<input type="url" aria-label="Connect service" value={service} disabled={busy} onChange={event => { setService(event.target.value); setCode(''); setError(''); }} /></label>
    </details>
  </div>;
}
