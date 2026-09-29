'use client';
import { useEffect, useRef, useState } from 'react';
import styles from './browser-access.module.css';

export function DesktopSignIn({ code, api, onError }: {
  code: string;
  api: (path: string, body?: unknown) => Promise<any>;
  onError: (error: unknown) => void;
}) {
  const [info, setInfo] = useState<{ approved: boolean; denied: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  useEffect(() => {
    let active = true;
    void api(`/desktop/info?code=${encodeURIComponent(code)}`).then(value => {
      if (active) setInfo(value);
    }).catch(error => { if (active) onError(error); });
    return () => { active = false; };
  }, [code, api, onError]);
  async function approve(approved: boolean) {
    if (submitting.current || !info) return;
    submitting.current = true; setBusy(true);
    try { await api('/desktop/approve', { code, approved }); setInfo({ approved, denied: !approved }); }
    catch (error) { onError(error); }
    finally { submitting.current = false; setBusy(false); }
  }
  if (!info) return <p role="status">Checking desktop sign-in…</p>;
  return <section className={styles.card} aria-label="Desktop sign-in">
    <h2>{info.approved ? 'Desktop sign-in approved' : info.denied ? 'Desktop sign-in declined' : 'Sign in to Zana Desktop?'}</h2>
    {info.approved || info.denied ? <p>{info.approved ? 'Return to Zana. Your shared instances will appear automatically.' : 'Return to Zana to start again.'}</p> : <>
      <p>Approve only if you clicked Sign in in the Zana desktop app. This gives that app access to your account and shared instances.</p>
      <button className="zcc-btn zcc-btn-primary" disabled={busy} onClick={() => void approve(true)}>Approve desktop sign-in</button>{' '}
      <button className="zcc-btn" disabled={busy} onClick={() => void approve(false)}>Decline</button>
    </>}
  </section>;
}
