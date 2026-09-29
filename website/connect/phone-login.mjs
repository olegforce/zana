import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { CODE_TTL, ConnectError, credentialValid, digest } from './registry.mjs';

const validCode = value => typeof value === 'string' && /^[\w-]{22}$/.test(value);
const one = async (query, sql, args) => (await query(sql, args))[0];

/** Browser approval never receives the private polling secret or phone credential. */
export function createPhoneLogin(db, { accountUrl, domain, now, limit }) {
  return {
    async startPhoneLogin(name) {
      if (typeof name !== 'string' || !name.trim() || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) throw new ConnectError('invalid_name');
      const deviceCode = randomBytes(32).toString('base64url');
      const userCode = randomBytes(16).toString('base64url');
      const expiresAt = now() + CODE_TTL;
      await db.transaction('phone-login', async query => {
        await query('DELETE FROM connect_codes WHERE hash IN (SELECT hash FROM connect_codes WHERE expires_at<=$1 LIMIT 200)', [now()]);
        const count = await one(query, 'SELECT COUNT(*) AS n FROM connect_codes WHERE purpose=$1 AND expires_at>$2', ['phone-login', now()]);
        if (Number(count.n) >= 1000) throw new ConnectError('busy', 429);
        await query('INSERT INTO connect_codes(hash,purpose,name,device_hash,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6)', [digest(userCode), 'phone-login', name.trim(), digest(deviceCode), expiresAt, now()]);
      });
      return { deviceCode, userCode, expiresAt, interval: 3000, verificationUrl: `${accountUrl}/connect/?phone=${userCode}` };
    },
    async phoneLoginInfo(code) {
      if (!validCode(code)) throw new ConnectError('invalid_code');
      const row = await one(db.query, 'SELECT name,expires_at,consumed_at,denied_at FROM connect_codes WHERE hash=$1 AND purpose=$2', [digest(code), 'phone-login']);
      if (!row || Number(row.expires_at) <= now()) throw new ConnectError('expired', 410);
      return { name: row.name, approved: row.consumed_at != null && row.denied_at == null, denied: row.denied_at != null };
    },
    async approvePhoneLogin(userId, code, approved) {
      if (!validCode(code) || typeof userId !== 'string' || !userId || typeof approved !== 'boolean') throw new ConnectError('invalid_approval');
      return db.transaction(userId, async query => {
        const row = await one(query, 'UPDATE connect_codes SET consumed_at=$1,user_id=$2,denied_at=$3 WHERE hash=$4 AND purpose=$5 AND consumed_at IS NULL AND expires_at>$1 RETURNING hash', [now(), userId, approved ? null : now(), digest(code), 'phone-login']);
        if (!row) throw new ConnectError('expired_or_used', 409);
        return { approved, denied: !approved };
      });
    },
    async pollPhoneLogin(deviceCode) {
      if (!credentialValid(deviceCode)) throw new ConnectError('invalid_code');
      const row = await one(db.query, 'SELECT * FROM connect_codes WHERE device_hash=$1 AND purpose=$2', [digest(deviceCode), 'phone-login']);
      if (!row || Number(row.expires_at) <= now()) throw new ConnectError('expired', 410);
      if (row.denied_at != null) throw new ConnectError('denied', 403);
      if (!row.consumed_at || !row.user_id) return { pending: true };
      // Idempotent delivery under the account lock, including capacity and revocation.
      // The request expires long before revoked credentials can be pruned (90 days).
      return db.transaction(row.user_id, async query => {
        if (Number(row.expires_at) <= now()) throw new ConnectError('expired', 410);
        const credential = createHash('sha256').update(`zana-connect-phone:${deviceCode}`).digest('base64url');
        let device = await one(query, 'SELECT id,user_id,revoked_at FROM connect_devices WHERE credential_hash=$1', [digest(credential)]);
        if (device && (device.revoked_at != null || device.user_id !== row.user_id)) throw new ConnectError('revoked', 403);
        if (!device) {
          const count = await one(query, 'SELECT COUNT(*) AS n FROM connect_devices WHERE user_id=$1 AND revoked_at IS NULL', [row.user_id]);
          if (Number(count.n) >= limit) throw new ConnectError('account_limit', 409);
          device = { id: randomUUID() };
          await query('INSERT INTO connect_devices(id,user_id,name,credential_hash,created_at) VALUES($1,$2,$3,$4,$5)', [device.id, row.user_id, row.name, digest(credential), now()]);
        }
        return { credential, deviceId: device.id, connectDomain: domain, accountUrl };
      });
    }
  };
}
