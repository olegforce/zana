import { expect, it } from 'vitest';
import { connectReturn, connectReturnCookie, readConnectReturn } from './connect-return';
it('keeps OAuth returns on the account approval page and refuses open redirects', () => {
  const path = `/connect/?code=${'a'.repeat(22)}`;
  expect(connectReturn(path)).toBe(path);
  expect(connectReturn(`/connect/?browser=${'b'.repeat(22)}`)).toBe(`/connect/?browser=${'b'.repeat(22)}`);
  expect(connectReturn(`/connect/?browser=${'b'.repeat(22)}&returnTo=https://evil.test`)).toBe('/dashboard');
  expect(connectReturn(`/connect/?slack=${'a'.repeat(22)}`)).toBe(`/connect/?slack=${'a'.repeat(22)}`);
  expect(connectReturn(`/connect/?slack=${'a'.repeat(22)}&next=evil`)).toBe('/dashboard');
  expect(readConnectReturn(new Request('https://example.com', { headers: { cookie: connectReturnCookie(path).split(';')[0] } }))).toBe(path);
  for (const input of ['https://evil.com', '//evil.com', '/connect/?next=evil', '/connect/../evil', null]) expect(connectReturn(input)).toBe('/dashboard');
  expect(readConnectReturn(new Request('https://example.com', { headers: { cookie: 'oauth_return=%ff' } }))).toBe('/dashboard');
  expect(connectReturnCookie('', true)).toContain('Max-Age=0');
});

it('preserves only a single well-formed phone approval code through OAuth', () => {
  expect(connectReturn(`/connect/?phone=${'p'.repeat(22)}`)).toBe(`/connect/?phone=${'p'.repeat(22)}`);
  expect(connectReturn(`/connect/?phone=${'p'.repeat(22)}&next=https://evil.test`)).toBe('/dashboard');
});

it('preserves desktop approval through OAuth without allowing a second redirect', () => {
  const path = `/connect/?desktop=${'d'.repeat(22)}`;
  expect(connectReturn(path)).toBe(path);
  expect(readConnectReturn(new Request('https://example.com', { headers: { cookie: connectReturnCookie(path).split(';')[0] } }))).toBe(path);
  expect(connectReturn(`${path}&next=https://evil.test`)).toBe('/dashboard');
});
