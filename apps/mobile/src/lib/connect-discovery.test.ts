import { expect, it, vi } from 'vitest';
import { isConnectServer } from './connect-discovery';
import { discoverServers } from './client';
import { EMPTY_STATE, parseMobileState, saveProfile } from './profiles';
const domain = 'connect.example.com';
const serverUrl = `https://s-${'a'.repeat(24)}.${domain}`;
const profile = { id: 'phone', label: 'Laptop', serverUrl, credential: 'k'.repeat(43), connectDomain: domain, accountUrl: 'https://example.com' };
const response = (value: unknown) => vi.fn(async () => Response.json(value)) as unknown as typeof fetch;
it('persists account pairing and refuses foreign routing namespaces', async () => {
  expect(parseMobileState(JSON.stringify(saveProfile(EMPTY_STATE, profile))).profiles[0]).toEqual(profile);
  for (const url of ['https://evil.example.com', `${serverUrl}.evil.com`, serverUrl.replace('https:', 'http:'), `${serverUrl}:444`, `${serverUrl}/secret`]) expect(isConnectServer(url, domain)).toBe(false);
  expect(() => parseMobileState(JSON.stringify(saveProfile(EMPTY_STATE, { ...profile, serverUrl: 'https://evil.com' })))).toThrow();
});
it('discovers online/offline computers through the account even if the paired laptop is gone', async () => {
  const fetcher = response({ servers: [{ id: 's1', name: 'Work', serverUrl, live: true }, { id: 's2', name: 'Home', serverUrl: serverUrl.replace(/a{24}/, 'b'.repeat(24)), live: false }, { id: 'revoked', revoked: true }] });
  expect(await discoverServers(profile, fetcher)).toHaveLength(2);
  expect(fetcher).toHaveBeenCalledWith('https://example.com/api/connect/servers', expect.objectContaining({ headers: expect.objectContaining({ Authorization: `Bearer ${profile.credential}` }), redirect: 'error' }));
  await expect(discoverServers({ ...profile, connectDomain: undefined }, fetcher)).rejects.toThrow('Sign in with GitHub');
  await expect(discoverServers(profile, response({ servers: [{ id: 's1', name: 'Trap', serverUrl: 'https://evil.com' }] }))).rejects.toThrow('Invalid computer');
  await expect(discoverServers(profile, response({ servers: Array(501).fill({}) }))).rejects.toThrow('Invalid computer list');
});
