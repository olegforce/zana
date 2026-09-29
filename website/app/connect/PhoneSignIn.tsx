'use client';
import { useEffect, useRef, useState } from 'react';
import styles from './browser-access.module.css';

export function PhoneSignIn({ code, api, onError }: {
  code: string;
  api: (path: string, body?: unknown) => Promise<any>;
  onError: (error: unknown) => void;
}) {
  const [info, setInfo] = useState<{ name: string; approved: boolean; denied: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  useEffect(() => {
    let active = true;
    void api(`/phone/info?code=${encodeURIComponent(code)}`).then(value => {
      if (active) setInfo(value);
    }).catch(error => { if (active) onError(error); });
    return () => { active = false; };
  }, [code, api, onError]);
  async function approve(approved: boolean) {
    if (submitting.current || !info) return;
    submitting.current = true; setBusy(true);
    try {
      await api('/phone/approve', { code, approved });
      setInfo({ ...info, approved, denied: !approved });
    } catch (error) { onError(error); }
    finally { submitting.current = false; setBusy(false); }
  }
  if (!info) return <p role="status">Checking phone sign-in…</p>;
  return <section className={styles.card} aria-label="Phone sign-in">
    <p className={styles.eyebrow}>Zana Mobile</p>
    <h2>{info.approved ? 'Your phone is approved' : info.denied ? 'Phone sign-in declined' : `Sign in on ${info.name}?`}</h2>
    {info.approved || info.denied ? <>
      <p>{info.approved ? 'Return to Zana Mobile and choose your computer.' : 'Return to Zana Mobile to start again.'}</p>
      <a className="zcc-btn zcc-btn-primary" href="zana://connect">Return to Zana Mobile</a>
    </> : <>
      <p>Approve only if you started this sign-in in Zana Mobile. This phone will be able to use agents and projects on the computers connected to your GitHub account. You can revoke access at any time.</p>
      <button className="zcc-btn zcc-btn-primary" disabled={busy} onClick={() => void approve(true)}>Approve phone</button>{' '}
      <button className="zcc-btn" disabled={busy} onClick={() => void approve(false)}>Decline</button>
    </>}
  </section>;
}
