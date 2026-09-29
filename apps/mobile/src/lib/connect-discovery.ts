import { URL } from 'whatwg-url-minimum';
import { normalizeServerUrl } from './urls';

/** Only send a shared account credential to hosts in the paired service's namespace. */
export function isConnectServer(serverUrl: string, domain: string): boolean {
  try {
    const url = new URL(normalizeServerUrl(serverUrl));
    if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/.test(domain) || domain.includes('..')) return false;
    return url.protocol === 'https:' && url.host.endsWith(`.${domain}`) && /^s-[a-f0-9]{24}$/.test(url.host.slice(0, -(domain.length + 1)));
  } catch { return false; }
}
