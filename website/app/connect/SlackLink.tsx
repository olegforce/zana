'use client';
import { useEffect, useState } from 'react';
import styles from './connect.module.css';
import slackStyles from './slack-link.module.css';

type Link = { id: string; team_id: string; team_name?: string | null; slack_user: string; state: string; computer: string };
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
  return <section className={`${styles.panel} ${slackStyles.panel}`} aria-labelledby="slack-link-title">
    <header className={styles.panelHeader}>
      <span className={`${styles.panelIcon} ${slackStyles.icon}`}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="m10 3-4 18M18 3l-4 18M4 9h17M3 15h17" /></svg>
      </span>
      <div><h2 id="slack-link-title">{code ? 'Connect Zana in Slack' : 'Slack connections'}</h2><p>Manage Slack access to your Zana.</p></div>
      {!!links.length && <span className={`${styles.count} ${slackStyles.count}`} aria-label={`${links.length} Slack connections`}>{links.length}</span>}
    </header>
    <div className={slackStyles.setup}>
    {error && <p role="alert">{error}</p>}
    {activation ? <><p>On <strong>{activation.computer}</strong>, open <strong>Plugins → Slack Bridge → Connect through Zana Connect</strong>. Paste this activation code within ten minutes.</p><label>Activation code <input readOnly value={activation.activationCode} onFocus={e => e.target.select()} /></label><p>This enables Slack control only after that computer confirms the connection. Treat this code as private.</p></> : info && <>
      <p>Link <strong>{info.user}</strong> ({info.userId}) in <strong>{info.team}</strong> to this account. Only continue if this is your Slack identity.</p>
      <label>Computer <select value={serverId} onChange={e => setServerId(e.target.value)}><option value="">Choose your computer</option>{computers.map(c => <option key={c.id} value={c.id}>{c.name} · {c.live ? 'Online' : 'Offline'}</option>)}</select></label>
      {!computers.length && <p>Connect a computer using Settings → Phone → Zana Connect first.</p>}
      <p>Tasks run on this computer. You choose the available Projects and channels in its Slack Bridge plugin. Slack replies are visible to that channel’s members.</p>
      <button className="zcc-btn zcc-btn-primary" disabled={busy || !serverId} onClick={() => void approve()}>Link this identity and computer</button>
    </>}
    </div>
    {!!links.length && <ul className={slackStyles.links} aria-label="Slack connections">{links.map(link => <li key={link.id} className={slackStyles.connection}>
      <div className={slackStyles.details}>
        <h3>{link.computer}</h3>
        <dl className={slackStyles.identity}>
          <div><dt>Slack user</dt><dd>{link.slack_user}</dd></div>
          <div><dt>Workspace</dt><dd className={link.team_name ? slackStyles.workspaceName : undefined} title={link.team_id}>{link.team_name || link.team_id}</dd></div>
        </dl>
        {link.state !== 'active' && <p className={slackStyles.hint}>Finish connecting in Slack Bridge on this computer.</p>}
      </div>
      <span className={`${styles.status} ${slackStyles.status} ${link.state === 'active' ? styles.online : slackStyles.pending}`}><span aria-hidden="true" />{link.state === 'active' ? 'Connected' : 'Awaiting activation'}</span>
      <button type="button" className={`zcc-btn zcc-btn-sm ${slackStyles.revoke}`} disabled={busy} aria-label={`Revoke Slack access for ${link.slack_user} in ${link.team_name || link.team_id}`} onClick={() => void revoke(link.id)}>Revoke access</button>
    </li>)}</ul>}
  </section>;
}
