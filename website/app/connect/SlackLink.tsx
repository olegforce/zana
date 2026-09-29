'use client';
import { useEffect, useState } from 'react';
import styles from './connect.module.css';

type Link = { id: string; team_id: string; slack_user: string; state: string; computer: string };
async function api(path: string, body?: unknown) {
  const url = new URL(`/api/connect/slack/${path}`, window.location.origin);
  url.pathname = `${url.pathname.replace(/\/$/, '')}/`;
  const response = await fetch(url.pathname + url.search, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(12_000), ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  if (!response.ok) throw new Error(response.status === 503 ? 'Slack account linking is not enabled on this service yet.' : response.status === 410 ? 'This link has expired. Start again from Zana Home in Slack.' : 'Could not update Slack access. Refresh and try again.');
  return response.json();
}
export function SlackLink({ computers }: { computers: { id: string; name: string; live: boolean }[] }) {
  const [code, setCode] = useState('');
  const [info, setInfo] = useState<{ team: string; user: string; userId: string }>();
  const [links, setLinks] = useState<Link[]>([]);
  const [serverId, setServerId] = useState('');
  const [activation, setActivation] = useState<{ activationCode: string; computer: string }>();
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    const pending = new URL(window.location.href).searchParams.get('slack') ?? ''; setCode(pending);
    void api('links').then(v => { if (alive) setLinks(v.links ?? []); }).catch(e => { if (alive && pending) setError(e.message); });
    if (pending) void api(`info?code=${encodeURIComponent(pending)}`).then(v => { if (alive) setInfo(v); }).catch(e => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, []);
  async function approve() {
    setBusy(true); setError('');
    try { setActivation(await api('approve', { code, serverId, approved: true })); window.history.replaceState(null, '', '/connect/'); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function revoke(id: string) {
    setBusy(true); setError('');
    try { await api('revoke', { id }); setLinks(v => v.filter(l => l.id !== id)); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  if (!code && !links.length) return null;
  return <section className={styles.approval} aria-labelledby="slack-link-title"><div>
    <p className={styles.eyebrow}>Slack / Your computer</p><h2 id="slack-link-title">Connect Zana in Slack</h2>
    {error && <p role="alert">{error}</p>}
    {activation ? <><p>On <strong>{activation.computer}</strong>, open <strong>Plugins → Slack Bridge → Connect through Zana Connect</strong>. Paste this activation code within ten minutes.</p><label>Activation code <input readOnly value={activation.activationCode} onFocus={e => e.target.select()} /></label><p>This enables Slack control only after that computer confirms the connection. Treat this code as private.</p></> : info && <>
      <p>Link <strong>{info.user}</strong> ({info.userId}) in <strong>{info.team}</strong> to this account. Only continue if this is your Slack identity.</p>
      <label>Computer <select value={serverId} onChange={e => setServerId(e.target.value)}><option value="">Choose your computer</option>{computers.map(c => <option key={c.id} value={c.id}>{c.name} · {c.live ? 'Online' : 'Offline'}</option>)}</select></label>
      {!computers.length && <p>Connect a computer using Settings → Phone → Zana Connect first.</p>}
      <p>Tasks run on this computer. You choose the available Projects and channels in its Slack Bridge plugin. Slack replies are visible to that channel’s members.</p>
      <button className="zcc-btn zcc-btn-primary" disabled={busy || !serverId} onClick={() => void approve()}>Link this identity and computer</button>
    </>}
    {!!links.length && <ul>{links.map(link => <li key={link.id}>{link.slack_user} · {link.team_id} → {link.computer} · {link.state === 'active' ? 'Connected' : 'Waiting for local activation'} <button disabled={busy} onClick={() => void revoke(link.id)}>Revoke Slack access</button></li>)}</ul>}
  </div></section>;
}
