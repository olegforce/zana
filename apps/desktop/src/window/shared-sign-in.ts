import { setTimeout as delay } from 'node:timers/promises';

export const SHARED_ACCOUNT = 'https://zana-ide.com';
const CODE = /^[A-Za-z0-9_-]{22}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const LOGIN_TTL = 600_000;
const CLOCK_SKEW = 60_000;

/** The public browser only sees the approval code; the polling secret stays in main. */
export async function signInWithBrowser(deps: {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  openExternal: (url: string) => Promise<void>;
}, signal: AbortSignal): Promise<{ cookieValue: string; expiresAt: number }> {
  async function request(action: string, body: unknown) {
    signal.throwIfAborted();
    const response = await deps.fetch(`${SHARED_ACCOUNT}/api/connect/desktop/${action}/`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      credentials: 'omit', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)])
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(response.status === 403 ? 'Sign-in was declined. Start again to sign in.'
        : response.status === 410 ? 'Sign-in expired. Please try again.' : 'Browser sign-in is unavailable. Please try again.');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Empty sign-in response');
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.length;
        if (size > 4096) { await reader.cancel(); throw new Error('Sign-in response too large'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    signal.throwIfAborted();
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  const login = await request('start', {});
  if (!login || !CODE.test(login.userCode) || !SECRET.test(login.deviceCode)
    || !Number.isFinite(login.expiresAt) || login.expiresAt <= Date.now() || login.expiresAt > Date.now() + LOGIN_TTL + CLOCK_SKEW) {
    throw new Error('Invalid sign-in response');
  }
  // Service timestamps use a different clock; never extend the local polling budget.
  const deadline = Math.min(login.expiresAt, Date.now() + LOGIN_TTL);
  // Construct the URL from a fixed origin, never a service-supplied redirect.
  await deps.openExternal(`${SHARED_ACCOUNT}/connect/?desktop=${login.userCode}`);
  while (Date.now() < deadline) {
    const result = await request('poll', { deviceCode: login.deviceCode });
    if (result?.pending === true) { await delay(3000, undefined, { signal }); continue; }
    if (!result || typeof result.cookieValue !== 'string' || !/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(result.cookieValue)
      || !Number.isFinite(result.expiresAt) || result.expiresAt <= Date.now() || result.expiresAt > Date.now() + 30 * 86400_000 + CLOCK_SKEW) {
      throw new Error('Invalid sign-in response');
    }
    return { cookieValue: result.cookieValue, expiresAt: result.expiresAt };
  }
  throw new Error('Sign-in expired. Please try again.');
}
