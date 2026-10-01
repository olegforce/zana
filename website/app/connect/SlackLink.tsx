'use client';
import { useEffect, useState } from 'react';
import styles from './connect.module.css';
import slackStyles from './slack-link.module.css';

type Link = { id: string; team_id: string; team_name?: string | null; slack_user: string; state: string; computer: string };
const localSetupUrl = 'http://127.0.0.1:8780/plugins/slack-bridge-2ff2/main/connect';
function setupUrl(browserUrl?: string | null) {
  if (!browserUrl) return localSetupUrl;
  try {
    const url = new URL(browserUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return localSetupUrl;
    return new URL('/plugins/slack-bridge-2ff2/main/connect', url.origin).toString();
  } catch {
    return localSetupUrl;
  }
}
async function api(path: string, body?: unknown) {
  const url = new URL(`/api/connect/slack/${path}`, window.location.origin);
  url.pathname = `${url.pathname.replace(/\/$/, '')}/`;
  const response = await fetch(url.pathname + url.search, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(12_000), ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  if (!response.ok) {
    const problem = await response.json().catch(() => ({}));
    throw new Error(problem.error === 'domain_not_owned' ? 'This domain is not connected to this account. Sign in with its owner account, or connect the domain in Zana first.' : response.status === 503 ? 'Slack account linking is not enabled on this service yet.' : response.status === 410 ? 'This link has expired. Start again from Zana Home in Slack.' : 'Could not update Slack access. Refresh and try again.');
  }
  return response.json();
}
export function SlackLink({ computers }: { computers: { id: string; name: string; live: boolean; browserUrl?: string | null }[] }) {
  const [code, setCode] = useState('');
  const [info, setInfo] = useState<{ team: string; user: string; userId: string; domain?: string; serverId?: string }>();
  const [links, setLinks] = useState<Link[]>([]);
  const [serverId, setServerId] = useState('');
  const [activation, setActivation] = useState<{ activationCode: string; computer: string }>();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    const pending = new URL(window.location.href).searchParams.get('slack') ?? ''; setCode(pending);
    void api('links').then(v => { if (alive) setLinks(v.links ?? []); }).catch(e => { if (alive && pending) setError(e.message); });
    if (pending) void api(`info?code=${encodeURIComponent(pending)}`).then(v => { if (alive) { setInfo(v); if (v.serverId) setServerId(v.serverId); } }).catch(e => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, []);
  async function approve() {
    setBusy(true); setError('');
    try { setActivation(await api('approve', { code, serverId, approved: true })); setCopied(false); window.history.replaceState(null, '', '/connect/'); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function revoke(id: string) {
    setBusy(true); setError('');
    try { await api('revoke', { id }); setLinks(v => v.filter(l => l.id !== id)); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  const selectedComputer = computers.find(computer => computer.id === serverId);
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
    {activation ? <><p>Finish on <strong>{activation.computer}</strong>. Copy the private code, then open the Zana for Slack setup page and paste it within ten minutes.</p><label>Activation code <input readOnly value={activation.activationCode} onFocus={e => e.target.select()} /></label><div className={styles.actions}><button type="button" className="zcc-btn zcc-btn-primary" onClick={() => {
      void navigator.clipboard.writeText(activation.activationCode).then(() => setCopied(true)).catch(() => setError('Could not copy. Select the activation code and copy it manually.'));
    }}>{copied ? 'Copied' : 'Copy activation code'}</button><a className="zcc-btn" href={setupUrl(selectedComputer?.browserUrl)} target="_blank" rel="noreferrer">Open Zana setup</a></div><p>This enables Slack control only after that computer confirms the connection. The code is never included in the link.</p></> : info && <>
      <p>Link <strong>{info.user}</strong> ({info.userId}) in <strong>{info.team}</strong> to this account. Only continue if this is your Slack identity.</p>
      {info.domain ? <p>Connect <strong>{info.domain}</strong> on <strong>{computers.find(c => c.id === info.serverId)?.name ?? 'your computer'}</strong>. This domain belongs to your signed-in account.</p> : <label>Computer <select value={serverId} onChange={e => setServerId(e.target.value)}><option value="">Choose your domain or computer</option>{computers.map(c => <option key={c.id} value={c.id}>{c.browserUrl ? `${new URL(c.browserUrl).host} · ` : ''}{c.name} · {c.live ? 'Online' : 'Offline'}</option>)}</select></label>}
      {!computers.length && <p>Connect a computer using Settings → Phone → Zana Connect first.</p>}
      <p>Tasks run on this computer. You choose the available Projects and channels in its Zana for Slack plugin. Slack replies are visible to that channel’s members.</p>
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
        {link.state !== 'active' && <p className={slackStyles.hint}>Finish connecting in Zana for Slack on this computer.</p>}
      </div>
      <span className={`${styles.status} ${slackStyles.status} ${link.state === 'active' ? styles.online : slackStyles.pending}`}><span aria-hidden="true" />{link.state === 'active' ? 'Connected' : 'Awaiting activation'}</span>
      <button type="button" className={`zcc-btn zcc-btn-sm ${slackStyles.revoke}`} disabled={busy} aria-label={`Revoke Slack access for ${link.slack_user} in ${link.team_name || link.team_id}`} onClick={() => void revoke(link.id)}>Revoke access</button>
    </li>)}</ul>}
  </section>;
}
