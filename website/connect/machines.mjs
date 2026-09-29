import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { CODE_TTL, ConnectError, credentialValid, digest } from './registry.mjs';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const nameOf = value => {
  if (typeof value !== 'string' || !value.trim() || value.length > 80 || /[\x00-\x1f\x7f]/.test(value)) throw new ConnectError('invalid_name');
  return value.trim();
};
const codeOf = value => {
  if (typeof value !== 'string' || value.length > 80) throw new ConnectError('invalid_code');
  const code = value.replace(/[\s-]/g, '').toUpperCase();
  if (!/^[0-9A-F]{32}$/.test(code)) throw new ConnectError('invalid_code');
  return code;
};
const key = code => createHash('sha256').update(`zana-host-enrollment:${code}`).digest();
function seal(code, value, scope) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(code), iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(scope));
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url');
}
function unseal(code, value, scope) {
  const bytes = Buffer.from(value, 'base64url');
  const cipher = createDecipheriv('aes-256-gcm', key(code), bytes.subarray(0, 12), { authTagLength: 16 });
  cipher.setAuthTag(bytes.subarray(12, 28));
  cipher.setAAD(Buffer.from(scope));
  return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
}

/** Adapted from BB's server-pair/machine-pair distinction; see NOTICE.md. */
export function createMachines(db, { serverUrl, accountUrl, now, limit }) {
  const activeServer = async (query, server) => {
    const [current] = await query('SELECT id FROM connect_servers WHERE id=$1 AND user_id=$2 AND credential_hash=$3 AND revoked_at IS NULL', [server.id, server.user_id, server.credential_hash]);
    if (!current) throw new ConnectError('revoked', 403);
  };
  const binding = async (query, server, instanceId) => {
    if (!uuid(instanceId)) throw new ConnectError('invalid_instance');
    await activeServer(query, server);
    await query('INSERT INTO connect_instances(server_id,instance_id,created_at) VALUES($1,$2,$3) ON CONFLICT(server_id) DO NOTHING', [server.id, instanceId, now()]);
    const [row] = await query('SELECT instance_id FROM connect_instances WHERE server_id=$1', [server.id]);
    if (row?.instance_id !== instanceId) throw new ConnectError('instance_mismatch', 409);
  };
  return {
    async bindInstance(server, instanceId) {
      return db.transaction(server.user_id, async query => {
        await binding(query, server, instanceId);
        return { serverId: server.id, instanceId };
      });
    },
    async createMachineCode(server, input) {
      if (!input || !uuid(input.hostId) || typeof input.enrollToken !== 'string' || !/^zcde_[\w-]{24}$/.test(input.enrollToken)) throw new ConnectError('invalid_enrollment');
      const name = nameOf(input.name);
      const raw = randomBytes(16).toString('hex').toUpperCase(), hash = digest(raw);
      const expiresAt = now() + CODE_TTL;
      await db.transaction(server.user_id, async query => {
        await binding(query, server, input.instanceId);
        const [count] = await query('SELECT COUNT(*) AS n FROM connect_machines WHERE user_id=$1 AND revoked_at IS NULL AND NOT (server_id=$2 AND host_id=$3)', [server.user_id, server.id, input.hostId]);
        if (Number(count.n) >= limit) throw new ConnectError('account_limit', 409);
        const [pending] = await query('SELECT COUNT(*) AS n FROM connect_machine_codes WHERE user_id=$1 AND expires_at>$2 AND consumed_at IS NULL AND NOT (server_id=$3 AND host_id=$4)', [server.user_id, now(), server.id, input.hostId]);
        if (Number(pending.n) >= limit) throw new ConnectError('account_limit', 409);
        await query('DELETE FROM connect_machine_codes WHERE server_id=$1 AND host_id=$2', [server.id, input.hostId]);
        await query('INSERT INTO connect_machine_codes(hash,user_id,server_id,host_id,name,enrollment,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [hash, server.user_id, server.id, input.hostId, name, seal(raw, input.enrollToken, `${server.id}:${input.hostId}`), expiresAt, now()]);
      });
      return { code: raw.match(/.{4}/g).join('-'), expiresAt, serverId: server.id, hostId: input.hostId, serverUrl: serverUrl(server.label) };
    },
    async redeemMachineCode(value, attemptSecret) {
      const raw = codeOf(value), hash = digest(raw);
      if (!credentialValid(attemptSecret)) throw new ConnectError('invalid_attempt');
      const [owner] = await db.query('SELECT user_id FROM connect_machine_codes WHERE hash=$1', [hash]);
      if (!owner) throw new ConnectError('expired_or_used', 409);
      return db.transaction(owner.user_id, async query => {
        const [row] = await query('SELECT c.*,v.label,b.instance_id FROM connect_machine_codes c JOIN connect_servers v ON v.id=c.server_id JOIN connect_instances b ON b.server_id=v.id WHERE c.hash=$1 AND c.expires_at>$2 AND v.revoked_at IS NULL AND v.user_id=c.user_id', [hash, now()]);
        if (!row || (row.consumed_at != null && row.request_hash !== digest(attemptSecret))) throw new ConnectError('expired_or_used', 409);
        const credential = createHash('sha256').update(`zana-connect-machine:${raw}:${attemptSecret}`).digest('base64url');
        let machineId = row.machine_id;
        if (row.consumed_at == null) {
          const [count] = await query('SELECT COUNT(*) AS n FROM connect_machines WHERE user_id=$1 AND revoked_at IS NULL AND NOT (server_id=$2 AND host_id=$3)', [row.user_id, row.server_id, row.host_id]);
          if (Number(count.n) >= limit) throw new ConnectError('account_limit', 409);
          const [existing] = await query('SELECT id FROM connect_machines WHERE server_id=$1 AND host_id=$2', [row.server_id, row.host_id]);
          machineId = existing?.id ?? randomUUID();
          await query('INSERT INTO connect_machines(id,user_id,server_id,host_id,name,credential_hash,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(server_id,host_id) DO UPDATE SET credential_hash=excluded.credential_hash,name=excluded.name,revoked_at=NULL', [machineId, row.user_id, row.server_id, row.host_id, row.name, digest(credential), now()]);
          await query('UPDATE connect_machine_codes SET consumed_at=$1,request_hash=$2,machine_id=$3 WHERE hash=$4', [now(), digest(attemptSecret), machineId, hash]);
        }
        const [active] = await query('SELECT id FROM connect_machines WHERE id=$1 AND credential_hash=$2 AND revoked_at IS NULL', [machineId, digest(credential)]);
        if (!active) throw new ConnectError('revoked', 403);
        return { machineId, hostId: row.host_id, serverId: row.server_id, instanceId: row.instance_id, serverUrl: serverUrl(row.label), accountUrl, credential, enrollToken: unseal(raw, row.enrollment, `${row.server_id}:${row.host_id}`), expiresAt: Number(row.expires_at) };
      });
    },
    async authenticateMachine(server, credential) {
      if (!credentialValid(credential)) return null;
      return (await db.query('SELECT m.*,b.instance_id FROM connect_machines m JOIN connect_servers v ON v.id=m.server_id JOIN connect_instances b ON b.server_id=v.id WHERE m.credential_hash=$1 AND m.server_id=$2 AND m.user_id=$3 AND v.user_id=m.user_id AND m.revoked_at IS NULL AND v.revoked_at IS NULL', [digest(credential), server.id, server.user_id]))[0] ?? null;
    },
    async authorizeMachineGrant(server, machine) {
      return (await db.query('SELECT m.id FROM connect_machines m JOIN connect_servers v ON v.id=m.server_id WHERE m.id=$1 AND m.credential_hash=$2 AND m.server_id=$3 AND m.user_id=$4 AND v.user_id=m.user_id AND m.revoked_at IS NULL AND v.revoked_at IS NULL', [machine.id, machine.credential_hash, server.id, server.user_id]))[0] ?? null;
    },
    async listMachines(userId, serverId) {
      return (await db.query('SELECT id,server_id,host_id,name,created_at,last_seen_at,revoked_at FROM connect_machines WHERE user_id=$1 AND server_id=$2 ORDER BY created_at DESC LIMIT $3', [userId, serverId, limit])).map(row => ({ id: row.id, serverId: row.server_id, hostId: row.host_id, name: row.name, createdAt: Number(row.created_at), lastSeenAt: row.last_seen_at == null ? null : Number(row.last_seen_at), revoked: row.revoked_at != null }));
    },
    async revokeMachine(server, hostId) {
      if (!uuid(hostId)) throw new ConnectError('invalid_host');
      return db.transaction(server.user_id, async query => {
        await activeServer(query, server);
        await query('DELETE FROM connect_machine_codes WHERE server_id=$1 AND host_id=$2', [server.id, hostId]);
        return (await query('UPDATE connect_machines SET revoked_at=$1 WHERE server_id=$2 AND host_id=$3 AND user_id=$4 AND revoked_at IS NULL RETURNING id', [now(), server.id, hostId, server.user_id]))[0]?.id ?? null;
      });
    }
  };
}
