import { addressError } from '../connect/addresses.mjs';
import { SlackError } from './security.mjs';

/** A claimed Connect address is a selector, never an arbitrary fetch target. */
export function domainLabel(value, browserDomain) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length > 253 || /[\\%\s]/.test(value.trim())) throw new SlackError('invalid_domain');
  const input = value.trim().toLowerCase();
  if (!addressError(input)) return input;
  let url;
  try { url = new URL(input.includes('://') ? input : `https://${input}`); }
  catch { throw new SlackError('invalid_domain'); }
  const suffix = `.${browserDomain}`;
  const label = url.host.endsWith(suffix) ? url.host.slice(0, -suffix.length) : '';
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || addressError(label)) throw new SlackError('invalid_domain');
  return label;
}

export function createSlackOnboarding({ registry, connect }) {
  return async (user, domain) => {
    const label = domainLabel(domain, connect.browserDomain);
    const code = await registry.start(user, label);
    return {
      status: 'approval_required',
      ...(label ? { domain: new URL(connect.browserUrl(label)).host } : {}),
      connect_url: `${connect.accountUrl}/connect/?slack=${code}`,
      expires_in_seconds: 600,
      message: 'Open this private link, sign in to the Zana account that owns your domain, and approve the connection on your computer. No access is enabled until local approval. Keep the link private; it expires in ten minutes.',
    };
  };
}
