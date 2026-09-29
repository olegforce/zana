import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { getHost } from '@zana-ai/zcc-db';
import type { ProductHttpContext } from '../../http/product-context.js';
import { MobileConnectionStore } from '../../mobile/connection.js';
import { connectRequest, type ConnectFetch } from '../../mobile/connect-account.js';

function connection(ctx: ProductHttpContext) {
  return new MobileConnectionStore(join(ctx.dataDir, 'mobile', 'connection.json')).read();
}

export function usesConnect(ctx: ProductHttpContext): boolean { return connection(ctx).mode === 'connect'; }

export function connectInstallCommand(issued: { accountUrl: string; serverId: string; code: string }): string {
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  return `(umask 077; f=$(mktemp); trap 'rm -f "$f"' EXIT; curl --proto '=https' -fsS --connect-timeout 10 --max-time 30 ${quote(issued.accountUrl + '/api/connect/host-installer')} -o "$f" && node "$f" --account ${quote(issued.accountUrl)} --server-id ${quote(issued.serverId)} --code ${quote(issued.code)})`;
}

export async function issueConnectHostCode(ctx: ProductHttpContext, input: unknown, fetcher?: ConnectFetch) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Enter a machine name');
  const row = input as Record<string, unknown>;
  if (Object.keys(row).some(key => key !== 'name' && key !== 'hostId') || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 80 || /[\x00-\x1f\x7f]/.test(row.name)) throw new Error('Enter a valid machine name');
  if (row.hostId !== undefined) {
    const host = typeof row.hostId === 'string' ? getHost(ctx.db, row.hostId) : null;
    if (!host || host.destroyedAt || host.isPrimary) throw new Error('Choose an existing execution machine to repair');
  }
  const config = connection(ctx);
  if (config.mode !== 'connect') throw new Error('Connect this Zana instance before adding machines through your account');
  const issued = typeof row.hostId === 'string' ? ctx.joinCodes.mintForHost(row.hostId) : ctx.joinCodes.mint();
  try {
    const result = await connectRequest(config.accountUrl!, '/hosts/code', config.relayToken, {
      instanceId: ctx.productInstanceId, hostId: issued.hostId, name: row.name.trim(), enrollToken: issued.joinCode
    }, fetcher);
    if (result.serverId !== config.serverId || result.hostId !== issued.hostId || result.serverUrl !== config.publicUrl ||
      typeof result.code !== 'string' || !/^(?:[A-F0-9]{4}-){7}[A-F0-9]{4}$/.test(result.code) ||
      !Number.isFinite(result.expiresAt) || result.expiresAt <= Date.now() || result.expiresAt > issued.expiresAt) throw new Error('Invalid machine enrollment response');
    return { enrollmentId: createHash('sha256').update(issued.joinCode).digest('hex'), code: result.code, expiresAt: result.expiresAt as number, hostId: issued.hostId, serverId: config.serverId!, serverUrl: config.publicUrl!, accountUrl: config.accountUrl! };
  } catch (error) {
    ctx.joinCodes.invalidateHost(issued.hostId);
    throw error;
  }
}

export async function revokeConnectHost(ctx: ProductHttpContext, hostId: string, fetcher?: ConnectFetch): Promise<void> {
  const config = connection(ctx);
  if (config.mode !== 'connect') return;
  // Cloud revocation precedes local deletion; failure leaves the visible machine
  // available for an explicit retry instead of reporting a false success.
  await connectRequest(config.accountUrl!, '/hosts/revoke', config.relayToken, { hostId }, fetcher);
}
