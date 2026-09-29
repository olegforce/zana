'use client';
import { useEffect, useId, useRef, useState } from 'react';
import styles from './connect.module.css';
import addressStyles from './browser-access.module.css';

type Computer = { id: string; browserUrl?: string | null; paired?: boolean; live: boolean; revoked: boolean };
type Pairing = { code: string; expiresAt: number; serverId: string; browserUrl: string };
export function ComputerCode({ api, onError, onChanged, domain, computers }: {
  api(path: string, body?: unknown): Promise<any>; onError(error: unknown): void;
  onChanged(): Promise<void>; domain: string; computers: Computer[];
}) {
  const id = useId();
  const [label, setLabel] = useState('');
  const [selected, setSelected] = useState('');
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [progress, setProgress] = useState<'waiting' | 'paired' | 'online'>('waiting');
  const [pollError, setPollError] = useState(false);
  const callbacks = useRef({ api, onChanged }); callbacks.current = { api, onChanged };
  const pending = computers.filter(server => server.paired === false && !server.revoked);
  const server = pending.find(server => server.id === selected) ?? pending[0];
  const serverId = pairing?.serverId ?? server?.id;
  const browserUrl = pairing?.browserUrl ?? server?.browserUrl;
  const valid = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/.test(label) && !label.includes('--');
  const expired = !!pairing && now >= pairing.expiresAt;
  useEffect(() => {
    if (!pairing) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pairing]);
  useEffect(() => {
    if (!serverId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    setProgress('waiting'); setPollError(false);
    const poll = async () => {
      try {
        const account = await callbacks.current.api('/account');
        if (!active) return;
        const computer = account.servers.find((item: Computer) => item.id === serverId && !item.revoked);
        setPollError(false);
        if (computer?.live) {
          setProgress('online');
          await callbacks.current.onChanged();
          return;
        }
        setProgress(computer?.paired ? 'paired' : 'waiting');
      } catch { if (active) setPollError(true); }
      if (active) timer = setTimeout(() => void poll(), 3000);
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [serverId]);
  const generate = async () => {
    if (busy || (!serverId && !valid)) return;
    setBusy(true); setCopied(false);
    try {
      const next = serverId
        ? { ...await api('/computer/code', { serverId }), serverId, browserUrl }
        : await api('/computer/reserve', { label });
      setNow(Date.now()); setPairing(next); setProgress('waiting');
      await onChanged();
    } catch (err) { onError(err); }
    finally { setBusy(false); }
  };
  return <section className={styles.computerCode} aria-labelledby={`${id}-title`}>
    <h2 id={`${id}-title`}>{serverId ? 'Connect your computer' : computers.length ? 'Create a separate Zana instance' : 'Connect your first computer'}</h2>
    {!serverId ? <form onSubmit={event => { event.preventDefault(); void generate(); }}>
      <p>Choose your permanent address, then connect the computer that will keep this Zana running.</p>
      <label htmlFor={`${id}-address`}>Your address</label>
      <div className={addressStyles.address}><input id={`${id}-address`} value={label} onChange={event => setLabel(event.target.value.toLowerCase())} placeholder="your-name" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={30} disabled={busy} aria-describedby={`${id}-hint`} /><span>.{domain}</span></div>
      <p id={`${id}-hint`}>3–30 letters, numbers, and single dashes. This address is permanent.</p>
      <button type="submit" className="zcc-btn zcc-btn-primary" disabled={busy || !valid}>{busy ? 'Reserving…' : 'Reserve address and get code'}</button>
    </form> : <>
      {pending.length > 1 && <label>Computer to connect <select value={serverId} disabled={busy} onChange={event => { setPairing(null); setSelected(event.target.value); }}>
        {pending.map(item => <option key={item.id} value={item.id}>{item.browserUrl}</option>)}
      </select></label>}
      <p><strong>{browserUrl}</strong></p>
      {progress === 'online' ? <><p role="status">Connected. Your Zana is ready.</p><a className="zcc-btn zcc-btn-primary" href={browserUrl!}>Open Zana</a></> : <>
        <p>In the desktop app, open <strong>Settings → Remote access</strong> and paste this code. It connects automatically.</p>
        {pairing && !expired && progress === 'waiting' && <code className={styles.pairingCode}>{pairing.code}</code>}
        <p role="status">{pollError ? 'Could not check the connection. Retrying automatically…' : progress === 'paired' ? 'Computer registered. Waiting for it to come online…' : expired ? 'This code expired. Get a new one for the same address.' : pairing ? `Waiting for your computer… Code expires in ${Math.ceil((pairing.expiresAt - now) / 60_000)} minutes. This page updates automatically.` : 'Address reserved. Get a code to finish connecting.'}</p>
        {progress === 'waiting' && <div className={styles.actions}>
          <button type="button" className="zcc-btn zcc-btn-primary" disabled={busy} onClick={() => void generate()}>{busy ? 'Generating…' : pairing ? 'Get a new code' : 'Get a connect code'}</button>
          {pairing && !expired && <button type="button" className="zcc-btn" onClick={() => {
            void navigator.clipboard.writeText(pairing.code).then(() => setCopied(true)).catch(() => onError(new Error('Could not copy. Select the code above and copy it manually.')));
          }}>{copied ? 'Copied' : 'Copy code'}</button>}
        </div>}
        {progress === 'paired' && <p>Keep Zana open on that computer. Check Remote access there if it stays offline.</p>}
      </>}
    </>}
  </section>;
}
