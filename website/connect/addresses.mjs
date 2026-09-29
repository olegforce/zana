import { ConnectError } from './registry.mjs';

const reserved = new Set('www api app zana connect dashboard about blog docs download downloads help legal privacy status support terms abuse account accounts admin auth billing login logout oauth register security settings signin signout signup sso assets cdn dns edge files gateway git internal mail origin proxy relay root static system tunnel websocket dev preview prod production staging test'.split(' '));
export function addressError(label) {
  if (typeof label !== 'string' || !/^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/.test(label) || label.includes('--')) return 'invalid_address';
  if (reserved.has(label) || label.startsWith('s-')) return 'reserved_address';
  return null;
}

export function createAddresses(db, { browserUrl, now, limit }) {
  return {
    async addressAvailability(label) {
      const error = addressError(label);
      if (error) throw new ConnectError(error);
      const rows = await db.query('SELECT label FROM connect_addresses WHERE label=$1', [label]);
      return { available: rows.length === 0, browserUrl: browserUrl(label) };
    },
    async claimAddress(userId, serverId, label) {
      const error = addressError(label);
      if (error) throw new ConnectError(error);
      return db.transaction(userId, async query => {
        const [server] = await query('SELECT id FROM connect_servers WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL', [serverId, userId]);
        if (!server) throw new ConnectError('unknown_server', 404);
        const [existing] = await query('SELECT label FROM connect_addresses WHERE server_id=$1', [serverId]);
        if (existing) {
          if (existing.label !== label) throw new ConnectError('address_already_claimed', 409);
          return { label, browserUrl: browserUrl(label) };
        }
        const [count] = await query('SELECT COUNT(*) AS n FROM connect_addresses WHERE user_id=$1', [userId]);
        if (Number(count.n) >= limit) throw new ConnectError('account_limit', 409);
        const rows = await query('INSERT INTO connect_addresses(label,server_id,user_id,created_at) VALUES($1,$2,$3,$4) ON CONFLICT(label) DO NOTHING RETURNING label', [label, serverId, userId, now()]);
        if (!rows.length) throw new ConnectError('address_taken', 409);
        return { label, browserUrl: browserUrl(label) };
      });
    }
  };
}
