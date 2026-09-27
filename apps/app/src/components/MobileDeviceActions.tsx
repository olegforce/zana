import { useEffect, useId, useRef, useState } from 'react';
import { MoreHorizontal, RotateCw, Share2, Smartphone } from 'lucide-react';
import { getNativeShell } from '../lib/native-shell.js';

/** Device utilities live in the drawer, leaving the header for agent actions. */
export function MobileDeviceActions() {
  const shell = getNativeShell();
  const nativeShare = shell?.capabilities.includes('share');
  const canShare = nativeShare || typeof navigator.share === 'function';
  const [open, setOpen] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const close = () => {
    setOpen(false);
    if (root.current?.contains(document.activeElement)) trigger.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  const share = async () => {
    setSharing(true);
    setError(null);
    try {
      const payload = { url: window.location.href };
      if (nativeShare) await shell!.request('share', payload);
      else await navigator.share(payload);
      close();
    } catch (error) {
      // Older shells answer only when the share sheet closes, which can outlast
      // their request deadline. That timeout does not mean opening it failed.
      const cancelled = error instanceof Error && (error.name === 'AbortError'
        || (nativeShare && error.message === 'native request timed out'));
      if (!cancelled) setError('Could not open sharing. Try again.');
      else close();
    } finally {
      setSharing(false);
    }
  };
  return <div className="mobile-device-actions" ref={root}
    onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false);
    }}
    onKeyDownCapture={(event) => {
      if (!open) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
      } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        const items = [...root.current!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')];
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }
    }}>
    <button type="button" ref={trigger} className="mobile-device-options" aria-label="Device options"
      aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
      onClick={() => setOpen((value) => !value)}>
      <MoreHorizontal size={22} aria-hidden="true" />
    </button>
    {open && <div id={menuId} className="mobile-device-menu" role="menu" aria-label="Device actions">
      {canShare && <button type="button" role="menuitem" onClick={() => void share()} disabled={sharing} aria-busy={sharing}>
        <Share2 size={20} aria-hidden="true" /><span>Share</span>
      </button>}
      <button type="button" role="menuitem" onClick={() => { close(); window.location.reload(); }}>
        <RotateCw size={20} aria-hidden="true" /><span>Reload</span>
      </button>
      {shell?.capabilities.includes('open-native') && <button type="button" role="menuitem"
        onClick={() => { close(); shell.post({ type: 'open-native', screen: 'device-settings' }); }}>
        <Smartphone size={20} aria-hidden="true" /><span>This device</span>
      </button>}
      {error && <p role="status">{error}</p>}
    </div>}
  </div>;
}
