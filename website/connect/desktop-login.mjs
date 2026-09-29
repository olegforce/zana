import { createHmac, randomBytes } from 'node:crypto';
import { CODE_TTL, ConnectError, credentialValid, digest } from './registry.mjs';

const validCode = value => typeof value === 'string' && /^[\w-]{22}$/.test(value);
// Released desktops compare server expiry with their own clock and strict TTL
// ceilings. Leave one minute of headroom so small clock differences stay valid.
const DESKTOP_CLOCK_HEADROOM = 60_000;

/** A one-time browser approval signs the isolated desktop session in. */
export function createDesktopLogin(db, { now, sessionSecret }) {
  return {
    async start() {
      const userCode = randomBytes(16).toString('base64url');
      const deviceCode = randomBytes(32).toString('base64url');
      const expiresAt = now() + CODE_TTL - DESKTOP_CLOCK_HEADROOM;
      await db.transaction('desktop-login', async query => {
        await query('DELETE FROM connect_desktop_logins WHERE hash IN (SELECT hash FROM connect_desktop_logins WHERE expires_at<=$1 LIMIT 200)', [now()]);
        const [count] = await query('SELECT COUNT(*) AS n FROM connect_desktop_logins WHERE expires_at>$1', [now()]);
        if (Number(count.n) >= 1000) throw new ConnectError('busy', 429);
        await query('INSERT INTO connect_desktop_logins(hash,device_hash,expires_at) VALUES($1,$2,$3)', [digest(userCode), digest(deviceCode), expiresAt]);
      });
      return { userCode, deviceCode, expiresAt };
    },
    async info(code) {
      if (!validCode(code)) throw new ConnectError('invalid_code');
      const [row] = await db.query('SELECT account_session_id,denied_at FROM connect_desktop_logins WHERE hash=$1 AND expires_at>$2', [digest(code), now()]);
      if (!row) throw new ConnectError('expired', 410);
      return { approved: row.account_session_id != null, denied: row.denied_at != null };
    },
    async approve(account, code, approved) {
      if (!validCode(code) || typeof approved !== 'boolean') throw new ConnectError('invalid_approval');
      return db.transaction('desktop-login', async query => {
        const rows = await query('UPDATE connect_desktop_logins SET account_session_id=$1,denied_at=$2 WHERE hash=$3 AND expires_at>$4 AND account_session_id IS NULL AND denied_at IS NULL RETURNING hash', [approved ? account.session_id : null, approved ? null : now(), digest(code), now()]);
        if (!rows.length) throw new ConnectError('expired_or_used', 409);
        return { approved, denied: !approved };
      });
    },
    async poll(deviceCode) {
      if (!credentialValid(deviceCode)) throw new ConnectError('invalid_code');
      return db.transaction('desktop-login', async query => {
        const [row] = await query('SELECT * FROM connect_desktop_logins WHERE device_hash=$1 AND expires_at>$2', [digest(deviceCode), now()]);
        if (!row) throw new ConnectError('expired', 410);
        if (row.denied_at != null) throw new ConnectError('denied', 403);
        if (!row.account_session_id) return { pending: true };
        const [source] = await query('SELECT user_id,expires_at FROM sessions WHERE id=$1 AND expires_at>$2', [row.account_session_id, now()]);
        if (!source) throw new ConnectError('expired', 410);
        if (!sessionSecret) throw new Error('Session signing unavailable');
        const id = randomBytes(32).toString('base64url');
        const expiresAt = Math.min(Number(source.expires_at), now() + 30 * 86400_000 - DESKTOP_CLOCK_HEADROOM);
        await query('INSERT INTO sessions(id,user_id,created_at,expires_at) VALUES($1,$2,$3,$4)', [id, source.user_id, now(), expiresAt]);
        await query('DELETE FROM connect_desktop_logins WHERE hash=$1', [row.hash]);
        // Only the main process holding deviceCode receives this value, never the approval page.
        return { cookieValue: `${id}.${createHmac('sha256', sessionSecret).update(id).digest('base64url')}`, expiresAt };
      });
    }
  };
}
