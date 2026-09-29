import { readFileSync, statSync } from 'node:fs';
import { writeSecretFile } from '@zana-ai/zcc-secret-storage';

export type MobileConnectionMode = 'unconfigured' | 'relay' | 'connect';
export interface MobileConnectionInput { mode: MobileConnectionMode; publicUrl?: string; relayToken?: string; accountUrl?: string; serverId?: string }
export interface MobileConnectionView { mode: MobileConnectionMode; publicUrl?: string; hasRelayToken: boolean; accountUrl?: string }

export class RemovedMobileConnectionError extends Error {
  constructor(mode = 'tailscale') {
    super(`${mode === 'local' ? 'Local-network' : 'Tailscale'} connections are no longer supported. Open Remote access to connect through Zana Connect.`);
  }
}

export function validateMobileConnection(input: unknown, previous?: MobileConnectionInput, managed = false): MobileConnectionInput {
  if (!input || typeof input !== 'object') throw new Error('Choose a phone connection method');
  const oldMode = (input as { mode?: unknown }).mode;
  if (oldMode === 'tailscale' || oldMode === 'local') throw new RemovedMobileConnectionError(oldMode);
  const candidate = input as MobileConnectionInput;
  if (managed && candidate.mode === 'unconfigured') return { mode: 'unconfigured' };
  if (!['relay', ...(managed ? ['connect'] : [])].includes(candidate.mode)) throw new Error('Unknown phone connection method');
  if (typeof candidate.publicUrl !== 'string' || candidate.publicUrl.length > 2048) throw new Error('Enter a valid HTTPS server address');
  let url: URL;
  try { url = new URL(candidate.publicUrl ?? ''); } catch { throw new Error('Enter a valid HTTPS server address'); }
  if (url.origin.length > 2048 || url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Use an HTTPS origin without a path or credentials');
  const publicUrl = url.origin;
  if (candidate.mode === 'connect') {
    const account = new URL(candidate.accountUrl ?? '');
    if (account.protocol !== 'https:' || account.origin !== candidate.accountUrl || !/^[\w-]{1,64}$/.test(candidate.serverId ?? '') || !/^[\w-]{43}$/.test(candidate.relayToken ?? '')) throw new Error('Invalid Connect enrollment');
    return { mode: 'connect', publicUrl, relayToken: candidate.relayToken, accountUrl: account.origin, serverId: candidate.serverId };
  }
  const relayToken = candidate.relayToken === undefined || candidate.relayToken === ''
    ? previous?.mode === 'relay' && previous.publicUrl === publicUrl ? previous.relayToken : undefined
    : candidate.relayToken;
  if (typeof relayToken !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(relayToken)) throw new Error('Enter the relay secret (43–128 URL-safe characters)');
  return { mode: 'relay', publicUrl, relayToken };
}

/** Small private main-owned file; never included in AppConfig or status projections. */
export class MobileConnectionStore {
  private value: MobileConnectionInput | undefined;
  constructor(private readonly path?: string) {}
  read(): MobileConnectionInput {
    if (this.value) return this.value;
    if (this.path) {
      try {
        if (statSync(this.path).size > 4096) throw new Error('Phone connection configuration is too large');
        this.value = validateMobileConnection(JSON.parse(readFileSync(this.path, 'utf8')), undefined, true);
        return this.value;
      } catch (error) {
        if (error instanceof RemovedMobileConnectionError) throw error;
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Could not read phone connection configuration');
      }
    }
    return { mode: 'unconfigured' };
  }
  // The owning manager serializes writes with start/stop transitions.
  async write(value: MobileConnectionInput): Promise<void> {
    if (this.path) await writeSecretFile(this.path, JSON.stringify(value));
    this.value = value;
  }
  view(): MobileConnectionView {
    const value = this.read();
    return { mode: value.mode, ...(value.publicUrl ? { publicUrl: value.publicUrl } : {}), hasRelayToken: !!value.relayToken, ...(value.accountUrl ? { accountUrl: value.accountUrl } : {}) };
  }
}
