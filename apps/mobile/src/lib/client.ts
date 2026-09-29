import { CONNECT_ACCOUNT_URL, isOnlineProfile, validAccount, validPhoneLogin, type AccountAccess, type PhoneLogin } from './profiles';
import { URL } from 'whatwg-url-minimum';
import type { ServerProfile } from './profiles';
import { normalizeServerUrl } from './urls';
import { isConnectServer } from './connect-discovery';
export interface SessionCookie {
  name: string;
  value: string;
  expires: string;
  secure: boolean;
  httpOnly: boolean;
  path: string;
}
export interface MobileSession {
  cookie: SessionCookie;
  expiresAt: number;
}
export class PairingRequired extends Error {}
async function request(serverUrl: string, path: string, init: RequestInit = {}, fetcher = fetch, maxBytes = 16_384) {
  const base = normalizeServerUrl(serverUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    let response: Response;
    try {
      response = await fetcher(base + path, {
        ...init,
        signal: controller.signal,
        redirect: 'error',
        headers: { 'x-zcc-app-surface': 'mobile', ...init.headers }
      });
    } catch {
      throw new Error(
        controller.signal.aborted
          ? 'The connection timed out. Check your network and try again.'
          : 'Could not reach your Zana server. Check that Zana is running and this phone can reach the server address.'
      );
    }
    if (response.url && new URL(response.url).origin !== base)
      throw new Error('The server redirected to another origin.');
    if (response.status === 401 || response.status === 403)
      throw new PairingRequired('Sign in with GitHub again to approve this phone.');
    if (!response.ok)
      throw new Error(
        response.status === 429
          ? 'Too many attempts. Try again in a minute.'
          : `Server returned ${response.status}.`
      );
    if (!(response.headers.get('content-type') ?? '').includes('application/json'))
      throw new Error('This URL is not a Zana server.');
    const text = await response.text();
    if (text.length > maxBytes) throw new Error('Server response is too large.');
    return JSON.parse(text) as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}
export async function startPhoneLogin(name: string, fetcher = fetch): Promise<PhoneLogin> {
  const result = await request(CONNECT_ACCOUNT_URL, '/api/connect/phone/start/', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name })
  }, fetcher);
  if (!validPhoneLogin(result) || result.expiresAt <= Date.now() || result.expiresAt > Date.now() + 15 * 60_000) throw new Error('Invalid sign-in response.');
  return result;
}
export async function pollPhoneLogin(login: PhoneLogin, fetcher = fetch): Promise<AccountAccess | null> {
  if (!validPhoneLogin(login) || login.expiresAt <= Date.now()) throw new Error('Sign-in expired. Cancel and sign in again.');
  const result = await request(CONNECT_ACCOUNT_URL, '/api/connect/phone/poll/', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceCode: login.deviceCode })
  }, fetcher);
  if (result.pending === true) return null;
  if (!validAccount(result) || result.accountUrl !== CONNECT_ACCOUNT_URL) throw new Error('Invalid account response.');
  return result;
}
export interface AccountServer { id: string; name: string; serverUrl: string; browserUrl?: string; live: boolean }
export async function discoverAccountServers(account: AccountAccess, fetcher = fetch): Promise<AccountServer[]> {
  if (!validAccount(account)) throw new Error('Sign in with GitHub again.');
  const result = await request(account.accountUrl, '/api/connect/servers/', { headers: { Authorization: `Bearer ${account.credential}` } }, fetcher, 262_144);
  if (!Array.isArray(result.servers) || result.servers.length > 500) throw new Error('Invalid computer list.');
  return result.servers.filter(server => server && !server.revoked).map(server => {
    if (typeof server.id !== 'string' || !/^[\w-]{1,64}$/.test(server.id) || typeof server.name !== 'string' || server.name.length > 80 || typeof server.serverUrl !== 'string' || !isConnectServer(server.serverUrl, account.connectDomain)) throw new Error('Invalid computer address.');
    // The friendly address is display-only; credentials use the generated gateway identity.
    let browserUrl: string | undefined;
    try { if (typeof server.browserUrl === 'string' && server.browserUrl.startsWith('https://') && normalizeServerUrl(server.browserUrl) === server.browserUrl) browserUrl = server.browserUrl; } catch { /* omit malformed display addresses */ }
    return { id: server.id, name: server.name, serverUrl: server.serverUrl, browserUrl, live: server.live === true };
  });
}
export async function discoverServers(profile: ServerProfile, fetcher = fetch): Promise<AccountServer[]> {
  if (!profile.credential || !profile.connectDomain || !profile.accountUrl?.startsWith('https://') || normalizeServerUrl(profile.accountUrl) !== profile.accountUrl || !isConnectServer(profile.serverUrl, profile.connectDomain)) throw new Error('Sign in with GitHub to connect a computer.');
  const result = await request(profile.accountUrl, '/api/connect/servers', { headers: { Authorization: `Bearer ${profile.credential}` } }, fetcher, 262_144);
  if (!Array.isArray(result.servers) || result.servers.length > 500) throw new Error('Invalid computer list.');
  return result.servers.filter(server => !server.revoked).map(server => {
    if (typeof server.id !== 'string' || !/^[\w-]{1,64}$/.test(server.id) || typeof server.name !== 'string' || server.name.length > 80 || typeof server.serverUrl !== 'string' || !isConnectServer(server.serverUrl, profile.connectDomain!)) throw new Error('Invalid computer address.');
    return { id: server.id, name: server.name, serverUrl: server.serverUrl, live: server.live === true };
  });
}
export async function createSession(
  profile: ServerProfile,
  fetcher = fetch
): Promise<MobileSession> {
  if (!isOnlineProfile(profile)) throw new PairingRequired('Local and direct connections are no longer supported. Sign in with GitHub to use Zana Connect.');
  const result = await request(
    profile.serverUrl,
    '/_mobile/session',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${profile.credential}`,
        'content-type': 'application/json'
      },
      body: '{}'
    },
    fetcher
  );
  const cookie = result.cookie as SessionCookie | undefined;
  if (
    !cookie ||
    cookie.name !== 'zcc_mobile_session' ||
    !/^[\w-]{43}$/.test(cookie.value) ||
    cookie.path !== '/' ||
    cookie.httpOnly !== true ||
    cookie.secure !== profile.serverUrl.startsWith('https:') ||
    typeof result.expiresAt !== 'number' ||
    result.expiresAt <= Date.now() ||
    !Number.isFinite(Date.parse(cookie.expires))
  )
    throw new Error('Invalid session response.');
  return { cookie, expiresAt: result.expiresAt };
}
