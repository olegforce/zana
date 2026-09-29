import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface ConnectHostAccess {
  serverUrl: string;
  serverId: string;
  instanceId: string;
  hostId: string;
  machineId: string;
  credential: string;
}

export function readConnectHostAccess(dataDir: string, serverUrl: string): ConnectHostAccess | null {
  const file = join(dataDir, 'connect-access.json');
  let value: unknown;
  try {
    if (statSync(file).size > 4096) throw new Error('Invalid machine access configuration');
    value = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('Invalid machine access configuration'); }
  if (!value || typeof value !== 'object') throw new Error('Invalid machine access configuration');
  const row = value as Record<string, unknown>;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (['hostId', 'serverId', 'instanceId', 'machineId'].some(key => typeof row[key] !== 'string' || !uuid.test(row[key])) ||
      typeof row.credential !== 'string' || !/^[\w-]{43}$/.test(row.credential) || typeof row.serverUrl !== 'string' ||
      row.serverUrl.replace(/\/$/, '') !== serverUrl.replace(/\/$/, '')) throw new Error('Machine access belongs to a different server or is invalid');
  return row as unknown as ConnectHostAccess;
}

/** Account credential is only sent to the configured server; redirects cannot leak it. */
export function connectHostFetch(serverUrl: string, credential?: string, fetchFn: typeof fetch = fetch): typeof fetch {
  if (!credential) return fetchFn;
  if (!/^[\w-]{43}$/.test(credential)) throw new Error('Invalid machine credential');
  const origin = new URL(serverUrl).origin;
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    if (target.origin !== origin || target.username || target.password) throw new Error('Machine request target mismatch');
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set('x-zcc-machine-credential', credential);
    return fetchFn(input, { ...init, headers, redirect: 'error' });
  }) as typeof fetch;
}

/** Retained until the authenticated hello, so failed installs can safely retry. */
export function readConnectEnrollment(dataDir: string, hostId: string | undefined): string | undefined {
  const file = join(dataDir, 'connect-enroll.json');
  try {
    if (statSync(file).size > 1024) throw new Error('Invalid pending machine enrollment');
    const row = JSON.parse(readFileSync(file, 'utf8'));
    if (row.hostId !== hostId || !/^zcde_[\w-]{24}$/.test(row.enrollToken)) throw new Error('Invalid pending machine enrollment');
    // A completed auth file may reconnect after this enrollment token expires.
    return row.enrollToken;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
