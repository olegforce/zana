import { useState } from 'react';
import { RotateCw, Share2, Smartphone } from 'lucide-react';
import { getNativeShell } from '../lib/native-shell.js';

/** Device utilities live in the drawer, leaving the header for agent actions. */
export function MobileDeviceActions() {
  const shell = getNativeShell();
  const nativeShare = shell?.capabilities.includes('share');
  const canShare = nativeShare || typeof navigator.share === 'function';
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const share = async () => {
    setSharing(true);
    setError(null);
    try {
      const payload = { url: window.location.href };
      if (nativeShare) await shell!.request('share', payload);
      else await navigator.share(payload);
    } catch (error) {
      // Older shells answer only when the share sheet closes, which can outlast
      // their request deadline. That timeout does not mean opening it failed.
      const cancelled = error instanceof Error && (error.name === 'AbortError'
        || (nativeShare && error.message === 'native request timed out'));
      if (!cancelled) setError('Could not open sharing. Try again.');
    } finally {
      setSharing(false);
    }
  };
  return <div className="mobile-device-actions" role="group" aria-label="Device actions">
    {canShare && <button type="button" onClick={() => void share()} disabled={sharing} aria-busy={sharing}>
      <Share2 size={20} aria-hidden="true" /><span>Share</span>
    </button>}
    <button type="button" onClick={() => window.location.reload()}>
      <RotateCw size={20} aria-hidden="true" /><span>Reload</span>
    </button>
    {shell?.capabilities.includes('open-native') && <button type="button"
      onClick={() => shell.post({ type: 'open-native', screen: 'device-settings' })}>
      <Smartphone size={20} aria-hidden="true" /><span>This device</span>
    </button>}
    {error && <p role="status">{error}</p>}
  </div>;
}
