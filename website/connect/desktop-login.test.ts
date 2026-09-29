import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { openConnectDatabase } from './database.mjs';
import { createRegistry } from './registry.mjs';
import { createConnectApi } from './http.mjs';
import { createDesktopLogin } from './desktop-login.mjs';

let db: any, api: any, desktop: any, now: number;
const origin = 'https://example.com', secret = 'fixture';
const cookie = `zcc_session=session.${createHmac('sha256', secret).update('session').digest('base64url')}`;
const owner = { cookie, origin };
const call = (path: string, body?: unknown, headers = {}) => api.dispatch(new Request(`${origin}/api/connect/${path}`, {
  method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) })
}));
beforeEach(async () => {
  now = Date.now(); db = await openConnectDatabase(':memory:', { production: false }); await db.migrate();
  await db.query('CREATE TABLE users(id TEXT PRIMARY KEY,github_login TEXT)');
  await db.query('CREATE TABLE sessions(id TEXT PRIMARY KEY,user_id TEXT,created_at BIGINT,expires_at BIGINT)');
  await db.query('INSERT INTO users VALUES($1,$1)', ['alice']);
  await db.query('INSERT INTO sessions VALUES($1,$2,$3,$4)', ['session', 'alice', now, now + 3600_000]);
  const registry = createRegistry(db, { domain: 'connect.example.com', accountUrl: origin, now: () => now });
  api = createConnectApi({ registry, db, sessionSecret: secret, now: () => now });
  desktop = createDesktopLogin(db, { sessionSecret: secret, now: () => now });
});
afterEach(async () => { vi.useRealTimers(); await db.close(); });
it('keeps start and session expirations compatible with released desktops when the server clock is ahead', async () => {
  vi.useFakeTimers();
  const localNow = Date.now();
  now = localNow + 250;
  await db.query('UPDATE sessions SET expires_at=$1 WHERE id=$2', [now + 30 * 86400_000, 'session']);
  const start = await desktop.start();
  // These are the exact strict ceilings checked by the already-installed client.
  expect(start.expiresAt).toBe(now + 9 * 60_000);
  expect(start.expiresAt).toBeLessThanOrEqual(localNow + 600_000);
  await desktop.approve({ session_id: 'session' }, start.userCode, true);
  const session = await desktop.poll(start.deviceCode);
  expect(session.expiresAt).toBeGreaterThan(localNow);
  expect(session.expiresAt).toBeLessThanOrEqual(localNow + 30 * 86400_000);
});
it('enforces the advertised shortened approval expiry in storage', async () => {
  const start = await desktop.start();
  now = start.expiresAt;
  await expect(desktop.poll(start.deviceCode)).rejects.toMatchObject({ status: 410 });
  await expect(desktop.info(start.userCode)).rejects.toMatchObject({ status: 410 });
  await expect(desktop.approve({ session_id: 'session' }, start.userCode, true)).rejects.toMatchObject({ status: 409 });
});
it('exchanges explicit browser approval for one desktop session and authenticates account discovery', async () => {
  const start = await (await call('desktop/start', {})).json();
  expect(await (await call('desktop/poll', { deviceCode: start.deviceCode })).json()).toEqual({ pending: true });
  expect(await (await call(`desktop/info?code=${start.userCode}`, undefined, owner)).json()).toEqual({ approved: false, denied: false });
  expect((await call('desktop/approve', { code: start.userCode, approved: true }, owner)).status).toBe(200);
  expect(await desktop.info(start.userCode)).toEqual({ approved: true, denied: false });
  const [first, second] = await Promise.all([call('desktop/poll', { deviceCode: start.deviceCode }), call('desktop/poll', { deviceCode: start.deviceCode })]);
  expect([first.status, second.status].sort()).toEqual([200, 410]);
  const result = await (first.status === 200 ? first : second).json();
  expect(result.expiresAt).toBe(now + 3600_000);
  const account = await call('account', undefined, { cookie: `zcc_session=${result.cookieValue}` });
  expect(await account.json()).toMatchObject({ user: { id: 'alice' }, servers: [], devices: [] });
  expect(await db.query('SELECT * FROM connect_desktop_logins')).toEqual([]);
  expect(await db.query('SELECT * FROM sessions')).toHaveLength(2);
});
it('requires browser authentication and same-origin approval and rejects malformed or foreign codes', async () => {
  const start = await desktop.start();
  expect((await call(`desktop/info?code=${start.userCode}`)).status).toBe(401);
  for (const headers of [{}, { cookie }, { cookie, origin: 'https://evil.test' }]) {
    expect((await call('desktop/approve', { code: start.userCode, approved: true }, headers)).status).toBe(headers.cookie ? 403 : 401);
  }
  for (const approved of [null, 1, 'yes']) expect((await call('desktop/approve', { code: start.userCode, approved }, owner)).status).toBe(400);
  expect((await call('desktop/approve', { code: 'bad', approved: true }, owner)).status).toBe(400);
  expect((await call('desktop/info?code=bad', undefined, owner)).status).toBe(400);
  expect((await call('desktop/poll', { deviceCode: 'bad' })).status).toBe(400);
  await expect(desktop.poll('bad')).rejects.toMatchObject({ status: 400 });
  expect((await call(`desktop/info?code=${'x'.repeat(22)}`, undefined, owner)).status).toBe(410);
  expect((await call('desktop/approve', { code: 'x'.repeat(22), approved: true }, owner)).status).toBe(409);
});
it('handles denial, expiry and revoked browser sessions without minting a desktop session', async () => {
  const denied = await desktop.start();
  await desktop.approve({ session_id: 'session' }, denied.userCode, false);
  expect(await desktop.info(denied.userCode)).toEqual({ approved: false, denied: true });
  await expect(desktop.poll(denied.deviceCode)).rejects.toMatchObject({ status: 403 });
  const revoked = await desktop.start(); await desktop.approve({ session_id: 'session' }, revoked.userCode, true);
  await db.query('DELETE FROM sessions');
  await expect(desktop.poll(revoked.deviceCode)).rejects.toMatchObject({ status: 410 });
  now += 600_001;
  await expect(desktop.info(revoked.userCode)).rejects.toMatchObject({ status: 410 });
  await expect(desktop.poll(revoked.deviceCode)).rejects.toMatchObject({ status: 410 });
  await desktop.start(); expect(await db.query('SELECT * FROM connect_desktop_logins')).toHaveLength(1);
  expect(await db.query('SELECT * FROM sessions')).toHaveLength(0);
});
it('caps pending requests, rate-limits starts, and rolls back when signing is unavailable', async () => {
  for (let i = 0; i < 30; i++) expect((await call('desktop/start', {})).status).toBe(200);
  expect((await call('desktop/start', {})).status).toBe(429);
  const start = await desktop.start(); await desktop.approve({ session_id: 'session' }, start.userCode, true);
  await expect(createDesktopLogin(db, { now: () => now, sessionSecret: '' }).poll(start.deviceCode)).rejects.toThrow('unavailable');
  expect(await desktop.info(start.userCode)).toEqual({ approved: true, denied: false });
  await db.transaction('fixture', async (query: any) => {
    for (let i = 31; i < 1000; i++) await query('INSERT INTO connect_desktop_logins(hash,device_hash,expires_at) VALUES($1,$1,$2)', [String(i), now + 60_000]);
  });
  await expect(desktop.start()).rejects.toMatchObject({ status: 429 });
});
