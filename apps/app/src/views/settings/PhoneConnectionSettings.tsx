import { useState } from 'react';
import { product } from '../../lib/product-client.js';

type Status = Awaited<ReturnType<typeof product.mobile.status>>;
type Mode = 'local' | 'tailscale' | 'relay';

export function PhoneConnectionSettings({ status, onSaved }: { status: Status | null; onSaved(): Promise<void> }) {
  const [mode, setMode] = useState<Mode>(status?.connection?.mode ?? 'local');
  const [publicUrl, setPublicUrl] = useState(status?.connection?.publicUrl ?? '');
  const [relayToken, setRelayToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const save = async () => {
    setSaving(true); setError(''); setSaved(false);
    try {
      await product.mobile.configure({ mode, ...(mode !== 'local' ? { publicUrl: publicUrl.trim() } : {}), ...(mode === 'relay' ? { relayToken } : {}) });
      setRelayToken('');
      await onSaved();
      setSaved(true);
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not save connection'); }
    finally { setSaving(false); }
  };
  return <div className="phone-connection-settings">
    <label className="settings-field">
      <strong>Connection method</strong>
      <select aria-label="Connection method" value={mode} disabled={saving} onChange={e => { setMode(e.target.value as Mode); setPublicUrl(''); setRelayToken(''); setSaved(false); }}>
        <option value="local">Local network</option>
        <option value="tailscale">Tailscale</option>
        <option value="relay">Heroku relay</option>
      </select>
    </label>
    {mode === 'local' ? <p className="settings-help">Use the same trusted Wi-Fi network as this computer. No extra service is needed.</p> : <>
      <label className="settings-field">{mode === 'tailscale' ? 'Tailscale HTTPS address' : 'Relay HTTPS address'}
        <input type="url" value={publicUrl} disabled={saving} onChange={e => { setPublicUrl(e.target.value); setSaved(false); }} placeholder={mode === 'tailscale' ? 'https://your-mac.your-network.ts.net' : 'https://your-relay.herokuapp.com'} spellCheck={false} />
      </label>
      {mode === 'tailscale' ? <div className="settings-help">
        <p>Install Tailscale on this computer and your phone, and sign in to the same private network. Enable HTTPS with Tailscale Serve, then paste its address above.</p>
        <code className="phone-connection-command">tailscale serve --bg --https=443 http://127.0.0.1:8785</code>
        <p>Check your existing Serve configuration before changing it. Zana keeps its gateway on this computer; only your Tailscale network can reach it.</p>
      </div> : <>
        <label className="settings-field">Relay secret
          <input type="password" value={relayToken} disabled={saving} onChange={e => { setRelayToken(e.target.value); setSaved(false); }} autoComplete="new-password" placeholder={status?.connection?.hasRelayToken ? 'Saved — leave blank to keep' : 'Paste MOBILE_RELAY_TOKEN'} />
        </label>
        <p className="settings-help">Deploy the Zana mobile relay to one always-on Heroku web dyno, then enter its HTTPS address and secret. This computer connects outward automatically. The relay operator can access traffic, so use an app you control.</p>
        {status?.connection?.mode === 'relay' && status.running && <p role="status">{status.relayState === 'connected' ? 'Relay connected' : 'Connecting to relay… Check the app address, secret and Heroku service if this persists.'}</p>}
      </>}
      <p className="settings-help">After saving, enable phone access and scan a fresh pairing QR for this address. Keep this computer awake and Zana running.</p>
    </>}
    <button type="button" className="btn" disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save connection'}</button>
    {saved && <p role="status">Connection saved.</p>}
    {error && <p role="alert" className="settings-help">{error}</p>}
  </div>;
}
