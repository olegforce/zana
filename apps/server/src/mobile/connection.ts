import { readFileSync, statSync } from 'node:fs';
import { writeSecretFile } from '@zana-ai/zcc-secret-storage';

export type MobileConnectionMode = 'local' | 'tailscale' | 'relay';
export interface MobileConnectionInput { mode: MobileConnectionMode; publicUrl?: string; relayToken?: string }
export interface MobileConnectionView { mode: MobileConnectionMode; publicUrl?: string; hasRelayToken: boolean }

export function validateMobileConnection(input: unknown, previous?: MobileConnectionInput): MobileConnectionInput {
  if (!input || typeof input !== 'object') throw new Error('Choose a phone connection method');
  const candidate = input as MobileConnectionInput;
  if (candidate.mode === 'local') return { mode: 'local' };
  if (!['tailscale', 'relay'].includes(candidate.mode)) throw new Error('Unknown phone connection method');
  if (typeof candidate.publicUrl !== 'string' || candidate.publicUrl.length > 2048) throw new Error('Enter a valid HTTPS server address');
  let url: URL;
  try { url = new URL(candidate.publicUrl ?? ''); } catch { throw new Error('Enter a valid HTTPS server address'); }
  if (url.origin.length > 2048 || url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Use an HTTPS origin without a path or credentials');
  if (candidate.mode === 'tailscale' && !url.hostname.endsWith('.ts.net')) throw new Error('Use the HTTPS .ts.net address from Tailscale Serve');
  const publicUrl = url.origin;
  if (candidate.mode === 'tailscale') return { mode: 'tailscale', publicUrl };
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
        this.value = validateMobileConnection(JSON.parse(readFileSync(this.path, 'utf8')));
        return this.value;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Could not read phone connection configuration'); }
    }
    return { mode: 'local' };
  }
  // The owning manager serializes writes with start/stop transitions.
  async write(value: MobileConnectionInput): Promise<void> {
    if (this.path) await writeSecretFile(this.path, JSON.stringify(value));
    this.value = value;
  }
  view(): MobileConnectionView {
    const value = this.read();
    return { mode: value.mode, ...(value.publicUrl ? { publicUrl: value.publicUrl } : {}), hasRelayToken: !!value.relayToken };
  }
}
