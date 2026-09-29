import { randomBytes } from 'node:crypto';
import { ConnectError, CODE_TTL, credentialValid, digest } from './registry.mjs';
import { browserNavigationReturn } from './browser-navigation.mjs';

const validCode = value => typeof value === 'string' && /^[\w-]{22}$/.test(value);
export const BROWSER_COOKIE = 'zcc_connect_session';
export const STATE_COOKIE = 'zcc_connect_state';
// Browser access follows the website login, rather than the one-hour phone
// access token that native clients can refresh. Every request still checks
// the parent account session, so logout/revocation cuts access immediately.
export const BROWSER_SESSION_TTL = 30 * 24 * 60 * 60_000;
export function browserReturnPath(value) {
  // Resolve as a path only. Backslashes/control characters can change browser URL parsing.
  if (typeof value !== 'string' || value.length > 4096 || !value.startsWith('/') || value.startsWith('//') || /[\\\x00-\x20\x7f]/.test(value)) return '/';
  const url = new URL(value, 'https://connect.invalid');
  if (url.origin !== 'https://connect.invalid' || url.pathname.startsWith('/_connect')) return '/';
  return url.pathname + url.search;
}
export const browserCookie = (name, value, secure, maxAge) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;

export function createBrowserAccess(db, registry, { now = Date.now } = {}) {
  const requestRow = async (query, code) => {
    if (!validCode(code)) throw new ConnectError('invalid_code');
    const [row] = await query('SELECT r.*,v.user_id,v.name,v.revoked_at FROM connect_browser_requests r JOIN connect_servers v ON v.id=r.server_id WHERE r.hash=$1 AND r.expires_at>$2 AND r.consumed_at IS NULL AND v.revoked_at IS NULL', [digest(code), now()]);
    if (!row) throw new ConnectError('expired_or_used', 410);
    return row;
  };
  const requireOwner = (row, account) => {
    if (row.user_id !== account.id) throw new ConnectError('not_your_server', 403);
  };
  return {
    async start(server, label, returnPath, intent) {
      const code = randomBytes(16).toString('base64url');
      const state = randomBytes(32).toString('base64url');
      await db.transaction('browser-enrollment', async query => {
        await query('DELETE FROM connect_browser_requests WHERE hash IN (SELECT hash FROM connect_browser_requests WHERE expires_at<=$1 LIMIT 200)', [now()]);
        const [count] = await query('SELECT COUNT(*) AS n FROM connect_browser_requests WHERE expires_at>$1', [now()]);
        if (Number(count.n) >= 1000) throw new ConnectError('busy', 429);
        await query('INSERT INTO connect_browser_requests(hash,state_hash,server_id,label,return_path,expires_at) VALUES($1,$2,$3,$4,$5,$6)', [digest(code), digest(state), server.id, label, browserReturnPath(returnPath), now() + CODE_TTL]);
      });
      return { state, location: browserNavigationReturn(registry.accountUrl, code, intent) };
    },
    async info(account, code) {
      const row = await requestRow(db.query, code); requireOwner(row, account);
      return { name: row.name, browserUrl: registry.browserUrl(row.label) };
    },
    async approve(account, code) {
      return db.transaction(account.id, async query => {
        const row = await requestRow(query, code); requireOwner(row, account);
        // Bind to this website session. Signing out also revokes its browser access.
        const [session] = await query('SELECT id FROM sessions WHERE id=$1 AND user_id=$2 AND expires_at>$3', [account.session_id, account.id, now()]);
        if (!session) throw new ConnectError('sign_in_required', 401);
        await query('UPDATE connect_browser_requests SET account_session_id=$1 WHERE hash=$2', [session.id, row.hash]);
        return { location: `${registry.browserUrl(row.label)}/_connect/callback?code=${code}` };
      });
    },
    async redeem(server, label, code, state) {
      if (!credentialValid(state)) throw new ConnectError('invalid_browser_state', 403);
      return db.transaction(server.user_id, async query => {
        const row = await requestRow(query, code);
        if (row.server_id !== server.id || row.label !== label || row.state_hash !== digest(state)) throw new ConnectError('invalid_browser_state', 403);
        const [accountSession] = await query('SELECT id,expires_at FROM sessions WHERE id=$1 AND user_id=$2 AND expires_at>$3', [row.account_session_id, row.user_id, now()]);
        if (!accountSession) throw new ConnectError('sign_in_required', 401);
        const consumed = await query('UPDATE connect_browser_requests SET consumed_at=$1 WHERE hash=$2 AND consumed_at IS NULL RETURNING hash', [now(), row.hash]);
        if (!consumed.length) throw new ConnectError('expired_or_used', 410);
        const value = randomBytes(32).toString('base64url');
        const expiresAt = Math.min(now() + BROWSER_SESSION_TTL, Number(accountSession.expires_at));
        await query('DELETE FROM connect_browser_sessions WHERE hash IN (SELECT hash FROM connect_browser_sessions WHERE expires_at<=$1 LIMIT 200)', [now()]);
        await query('DELETE FROM connect_browser_sessions WHERE account_session_id=$1 AND server_id=$2 AND label=$3', [accountSession.id, server.id, label]);
        await query('INSERT INTO connect_browser_sessions(hash,server_id,label,account_session_id,user_id,expires_at) VALUES($1,$2,$3,$4,$5,$6)', [digest(value), server.id, label, accountSession.id, row.user_id, expiresAt]);
        return { value, returnPath: row.return_path, maxAge: Math.max(1, Math.floor((expiresAt - now()) / 1000)) };
      });
    },
    async authorizeSession(server, label, value) {
      if (!credentialValid(value)) return null;
      const [row] = await db.query('SELECT b.user_id FROM connect_browser_sessions b JOIN sessions s ON s.id=b.account_session_id JOIN connect_servers v ON v.id=b.server_id WHERE b.hash=$1 AND b.server_id=$2 AND b.label=$3 AND b.expires_at>$4 AND s.expires_at>$4 AND s.user_id=b.user_id AND v.user_id=b.user_id AND v.revoked_at IS NULL', [digest(value), server.id, label, now()]);
      return row ?? null;
    }
  };
}
