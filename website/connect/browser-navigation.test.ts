import { expect, it } from 'vitest';
import { OPEN_TTL, createBrowserNavigation, verifyBrowserNavigation, browserNavigationReturn } from './browser-navigation.mjs';

const now = 1_800_000_000_000;
const account = { session_id: 'session' };
const domain = 'https://alice.example.com';

it('binds a short-lived dashboard navigation to the account session, domain and browser cookie', () => {
  const { intent, cookie } = createBrowserNavigation('secret', account, domain, now);
  const verify = (overrides: any = {}) => verifyBrowserNavigation(overrides.secret ?? 'secret', overrides.account ?? account, overrides.domain ?? domain, overrides.intent ?? intent, overrides.cookie ?? cookie, overrides.now ?? now);
  expect(verify()).toBe(true);
  expect(verify({ now: now + OPEN_TTL - 1 })).toBe(true);
  for (const overrides of [
    { secret: '' }, { secret: 'different' }, { account: { session_id: 'other-session' } },
    { domain: 'https://other.example.com' }, { intent: 'invalid' },
    { intent: `${now + OPEN_TTL}.${'a'.repeat(43)}` }, { cookie: '' }, { cookie: 'a'.repeat(43) },
    { now: now + OPEN_TTL }, { now: now - 1 }
  ]) expect(verify(overrides)).toBe(false);
  expect(browserNavigationReturn('https://example.com', 'code', intent)).toBe(`https://example.com/api/connect/browser/open/?code=code&intent=${intent}`);
});

it('keeps ordinary or malformed browser sign-ins on the explicit approval screen', () => {
  for (const intent of [undefined, null, '', 'https://evil.example', 'x'.repeat(1000)]) {
    expect(browserNavigationReturn('https://example.com', 'code', intent)).toBe('https://example.com/connect/?browser=code');
  }
});
