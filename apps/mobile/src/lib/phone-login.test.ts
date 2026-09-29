import { expect, it, vi } from 'vitest';
import { startPhoneLogin, pollPhoneLogin, discoverAccountServers, createSession } from './client';
import { CONNECT_ACCOUNT_URL, EMPTY_STATE, parseMobileState, validAccount, validPhoneLogin } from './profiles';
const login = { deviceCode: 'd'.repeat(43), userCode: 'u'.repeat(22), expiresAt: Date.now() + 600000, verificationUrl: `${CONNECT_ACCOUNT_URL}/connect/?phone=${'u'.repeat(22)}` };
const account = { accountUrl: CONNECT_ACCOUNT_URL, connectDomain: 'connect.zana-ide.com', credential: 'c'.repeat(43), deviceId: 'phone' };
const server = { id: 'mac', name: 'Mac', serverUrl: `https://s-${'a'.repeat(24)}.connect.zana-ide.com`, live: true, browserUrl: 'https://my-mac.zana-ide.com' };
const fetcher = (value: unknown) => vi.fn(async () => Response.json(value));
it('uses only the account HTTPS origin and keeps the polling secret in POST bodies', async () => {
  const begin = fetcher(login); expect(await startPhoneLogin('iPhone', begin)).toEqual(login);
  expect(begin).toHaveBeenCalledWith(`${CONNECT_ACCOUNT_URL}/api/connect/phone/start/`, expect.objectContaining({ redirect: 'error', body: JSON.stringify({ name: 'iPhone' }) }));
  const poll = fetcher(account); expect(await pollPhoneLogin(login, poll)).toEqual(account);
  expect(poll).toHaveBeenCalledWith(`${CONNECT_ACCOUNT_URL}/api/connect/phone/poll/`, expect.objectContaining({ body: JSON.stringify({ deviceCode: login.deviceCode }) }));
  expect(await pollPhoneLogin(login, fetcher({ pending: true }))).toBeNull();
});
it.each([{ verificationUrl: 'https://evil.test' }, { deviceCode: 'bad' }, { userCode: 7 }, { expiresAt: 0 }, { expiresAt: Date.now() + 3600000 }])('rejects malformed or misdirected login requests %j', async patch => {
  await expect(startPhoneLogin('Phone', fetcher({ ...login, ...patch }))).rejects.toThrow('Invalid sign-in');
});
it('rejects expired requests and credentials from a different account service', async () => {
  const network = fetcher(account); await expect(pollPhoneLogin({ ...login, expiresAt: 1 }, network)).rejects.toThrow('expired'); expect(network).not.toHaveBeenCalled();
  await expect(pollPhoneLogin(login, fetcher({ ...account, accountUrl: 'https://evil.test' }))).rejects.toThrow('Invalid account');
  await expect(pollPhoneLogin(login, fetcher({ ...account, credential: 'bad' }))).rejects.toThrow('Invalid account');
});
it('discovers account computers before saving any profile and never authenticates to the display alias', async () => {
  const network = fetcher({ servers: [server, { ...server, revoked: true }] });
  expect(await discoverAccountServers(account, network)).toEqual([server]);
  expect(network).toHaveBeenCalledWith(`${CONNECT_ACCOUNT_URL}/api/connect/servers/`, expect.objectContaining({ headers: expect.objectContaining({ Authorization: `Bearer ${account.credential}` }) }));
  const session = fetcher({ cookie: { name: 'zcc_mobile_session', value: 's'.repeat(43), path: '/', secure: true, httpOnly: true, expires: new Date(Date.now() + 60000).toISOString() }, expiresAt: Date.now() + 60000 });
  await createSession({ ...account, id: 'mac', label: 'Mac', serverUrl: server.serverUrl }, session);
  expect(session.mock.calls[0][0]).toBe(`${server.serverUrl}/_mobile/session`);
});
it.each([[], { servers: 'bad' }, { servers: Array(501).fill(server) }, { servers: [{ ...server, serverUrl: 'https://evil.test' }] }, { servers: [{ ...server, id: 12 }] }])('rejects invalid discovery responses %j', async response => {
  await expect(discoverAccountServers(account, fetcher(response))).rejects.toThrow();
});
it('drops malformed display-only addresses and validates persisted grants without losing legacy profiles', async () => {
  expect(await discoverAccountServers(account, fetcher({ servers: [{ ...server, browserUrl: 'https://user:password@evil.test' }] }))).toEqual([{ ...server, browserUrl: undefined }]);
  const old = { ...EMPTY_STATE, profiles: [{ id: 'old', label: 'LAN', serverUrl: 'http://192.168.1.2:8785' }], activeId: 'old' };
  expect(parseMobileState(JSON.stringify(old))).toEqual(old);
  expect(parseMobileState(JSON.stringify({ ...old, account, phoneLogin: login })).profiles).toEqual(old.profiles);
  for (const patch of [{ credential: 'bad' }, { deviceId: 2 }, { connectDomain: 'bad..test' }, { accountUrl: 'http://example.com' }, { accountUrl: 'not-a-url' }]) {
    expect(validAccount({ ...account, ...patch })).toBe(false);
    expect(() => parseMobileState(JSON.stringify({ ...old, account: { ...account, ...patch } }))).toThrow();
  }
  expect(validAccount(undefined)).toBe(false); expect(validPhoneLogin(null)).toBe(false);
  expect(() => parseMobileState(JSON.stringify({ ...old, phoneLogin: { ...login, verificationUrl: 'https://evil.test' } }))).toThrow();
  await expect(discoverAccountServers({ ...account, credential: 'bad' }, fetcher({}))).rejects.toThrow('Sign in');
});
