/** Target identity model adapted from BB apps/desktop/src/server-target.ts; see docs/third-party/bb-shared-machines.md. */
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export type SharedTarget = { kind: 'local' } | { kind: 'connect'; serverId: string; instanceId: string };
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export function validateSharedTarget(input: unknown): SharedTarget {
  if (input && typeof input === 'object' && 'kind' in input) {
    if (input.kind === 'local') return { kind: 'local' };
    if (input.kind === 'connect' && 'serverId' in input && 'instanceId' in input && uuid(input.serverId) && uuid(input.instanceId)) return { kind: 'connect', serverId: input.serverId, instanceId: input.instanceId };
  }
  throw new Error('Invalid saved Zana instance');
}
export function readSharedTarget(file: string): SharedTarget {
  try { if (statSync(file).size > 1024) throw new Error('Invalid saved Zana instance'); return validateSharedTarget(JSON.parse(readFileSync(file, 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'local' }; throw error; }
}
export function writeSharedTarget(file: string, input: SharedTarget): void {
  const target = validateSharedTarget(input), temporary = `${file}.${randomUUID()}.tmp`;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  try { writeFileSync(temporary, JSON.stringify(target), { flag: 'wx', mode: 0o600 }); renameSync(temporary, file); }
  finally { rmSync(temporary, { force: true }); }
}
export interface SharedInstance { id: string; instanceId: string; name: string; url: string; online: boolean }
export function accountInstances(value: unknown, domain = 'zana-ide.com'): SharedInstance[] {
  if (!value || typeof value !== 'object' || !('servers' in value) || !Array.isArray(value.servers) || value.servers.length > 200) throw new Error('Invalid Connect account response');
  return value.servers.filter((row: any) => !row.revoked && uuid(row.id) && uuid(row.instanceId)).map((row: any) => {
    const url = new URL(row.browserUrl ?? row.serverUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !(url.hostname.endsWith('.' + domain)) || url.port) throw new Error('Invalid account-owned instance address');
    return { id: row.id, instanceId: row.instanceId, name: String(row.name).slice(0, 80), url: url.origin, online: row.live === true };
  });
}
