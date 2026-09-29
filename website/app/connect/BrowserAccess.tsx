'use client';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import styles from './browser-access.module.css';

type Api = (path: string, body?: unknown) => Promise<any>;
interface Computer { id: string; name: string; browserUrl?: string | null }
export function BrowserLink({ serverId, browserUrl, api, onError, children, className, navigate = url => window.location.assign(url) }: {
  serverId: string; browserUrl: string; api: Api; onError: (error: unknown) => void; children: ReactNode; className?: string; navigate?: (url: string) => void;
}) {
  const opening = useRef(false);
  const [busy, setBusy] = useState(false);
  const open = async () => {
    if (opening.current) return;
    opening.current = true; setBusy(true);
    try { const result = await api('/browser/open', { serverId }); navigate(result.location); }
    catch (error) { onError(error); }
    finally { opening.current = false; setBusy(false); }
  };
  return <a className={className} href={browserUrl} aria-busy={busy} onClick={event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); void open();
  }}>{children}</a>;
}

export function AddressPicker({ computers, domain, api, onChanged, onError, disabled }: { computers: Computer[]; domain: string; api: Api; onChanged: () => Promise<void>; onError: (error: unknown) => void; disabled: boolean }) {
  const [selected, setSelected] = useState('');
  const [label, setLabel] = useState('');
  const [availability, setAvailability] = useState<'idle' | 'checking' | 'available' | 'taken' | 'failed'>('idle');
  const [busy, setBusy] = useState(false);
  const id = useId();
  const unclaimed = computers.filter(computer => !computer.browserUrl);
  const computer = unclaimed.find(item => item.id === selected) ?? unclaimed[0];
  const valid = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/.test(label) && !label.includes('--');
  useEffect(() => {
    if (!valid || !computer || disabled) { setAvailability('idle'); return; }
    let active = true;
    setAvailability('checking');
    const timer = setTimeout(() => {
      void api(`/address?label=${encodeURIComponent(label)}`).then(result => {
        if (active) setAvailability(result.available ? 'available' : 'taken');
      }).catch(error => { if (active) { setAvailability('failed'); onError(error); } });
    }, 400);
    return () => { active = false; clearTimeout(timer); };
  }, [label, valid, computer?.id, api, onError, disabled]);
  if (!computer) return null;
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || disabled || !valid || availability !== 'available') return;
    setBusy(true);
    try { await api('/address', { serverId: computer.id, label }); setLabel(''); await onChanged(); }
    catch (error) { setAvailability('failed'); onError(error); }
    finally { setBusy(false); }
  };
  return <section className={styles.card} aria-labelledby={`${id}-title`}>
    <p className={styles.eyebrow}>Zana in your browser</p>
    <h2 id={`${id}-title`}>Pick your address</h2>
    <p>A permanent address for your computer. Sign in with your Zana account from any browser while the desktop app is running.</p>
    <form onSubmit={event => void submit(event)}>
      {unclaimed.length > 1 ? <label className={styles.computer}>Computer<select value={computer.id} disabled={busy || disabled} onChange={event => setSelected(event.target.value)}>{unclaimed.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label> : <p>For <strong>{computer.name}</strong></p>}
      <label htmlFor={`${id}-address`}>Your address</label>
      <div className={styles.address}><input id={`${id}-address`} value={label} onChange={event => { setLabel(event.target.value); setAvailability('idle'); }} placeholder="your-name" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={30} aria-describedby={`${id}-hint ${id}-status`} disabled={busy || disabled} /><span>.{domain}</span></div>
      <small id={`${id}-hint`}>3–30 lowercase letters, numbers, and single dashes. Start and end with a letter or number. Your address cannot be renamed.</small>
      <p id={`${id}-status`} role="status" className={styles.status}>{availability === 'checking' ? 'Checking availability…' : availability === 'available' ? `Available: https://${label}.${domain}` : availability === 'taken' ? 'That address is taken. Try another name.' : label && !valid ? 'Enter a valid address using the format above.' : '\u00a0'}</p>
      <button type="submit" className="zcc-btn zcc-btn-primary" disabled={busy || disabled || !valid || availability !== 'available'}>{busy ? 'Claiming…' : 'Claim your address'}</button>
    </form>
  </section>;
}

export function BrowserSignIn({ code, api, onError, navigate = url => window.location.assign(url) }: { code: string; api: Api; onError: (error: unknown) => void; navigate?: (url: string) => void }) {
  const [info, setInfo] = useState<{ name: string; browserUrl: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void api(`/browser/info?code=${encodeURIComponent(code)}`).then(value => { if (active) setInfo(value); }).catch(error => { if (active) onError(error); });
    return () => { active = false; };
  }, [code, api, onError]);
  const open = async () => {
    setBusy(true);
    try { const result = await api('/browser/approve', { code }); navigate(result.location); }
    catch (error) { onError(error); }
    finally { setBusy(false); }
  };
  if (!info) return <p role="status">Checking browser access…</p>;
  return <section className={styles.card} aria-label="Browser sign-in">
    <p className={styles.eyebrow}>Zana Connect</p><h2>Open {info.name}</h2>
    <p>Continue to <strong>{info.browserUrl}</strong> to use your agents and projects in this browser.</p>
    <button className="zcc-btn zcc-btn-primary" disabled={busy} onClick={() => void open()}>{busy ? 'Opening…' : 'Open Zana'}</button>
  </section>;
}
