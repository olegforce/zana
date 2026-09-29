import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const OPEN_COOKIE = 'zcc_connect_open';
export const OPEN_TTL = 120_000;
const validIntent = value => typeof value === 'string' && /^\d{13}\.[\w-]{43}$/.test(value);
const signature = (secret, account, browserUrl, intent) => createHmac('sha256', secret)
  .update(JSON.stringify(['browser-open', account.session_id, browserUrl, intent])).digest('base64url');

// The dashboard sets this host-only HttpOnly cookie before leaving the account
// origin. A browser code from an unsolicited link cannot opt into auto-approval.
export function createBrowserNavigation(secret, account, browserUrl, now = Date.now()) {
  const intent = `${now + OPEN_TTL}.${randomBytes(32).toString('base64url')}`;
  return { intent, cookie: signature(secret, account, browserUrl, intent) };
}

export function verifyBrowserNavigation(secret, account, browserUrl, intent, cookie, now = Date.now()) {
  if (!secret || !validIntent(intent) || !/^[\w-]{43}$/.test(cookie)) return false;
  const expiresAt = Number(intent.split('.')[0]);
  if (expiresAt <= now || expiresAt > now + OPEN_TTL) return false;
  return timingSafeEqual(Buffer.from(cookie), Buffer.from(signature(secret, account, browserUrl, intent)));
}

export function browserNavigationReturn(accountUrl, code, intent) {
  return validIntent(intent)
    ? `${accountUrl}/api/connect/browser/open/?code=${code}&intent=${intent}`
    : `${accountUrl}/connect/?browser=${code}`;
}
