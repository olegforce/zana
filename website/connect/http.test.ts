import { afterEach, beforeEach, expect, it } from 'vitest';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { openConnectDatabase } from './database.mjs';
import { createRegistry } from './registry.mjs';
import { createConnectApi, browserAccount, readJson } from './http.mjs';
let db: any, registry: any, api: any;
const origin = 'https://example.com';
const secret = 'fixture';
const cookie = `zcc_session=session.${createHmac('sha256', secret).update('session').digest('base64url')}`;
beforeEach(async () => {
  db = await openConnectDatabase(':memory:', { production: false }); await db.migrate();
  await db.query('CREATE TABLE users(id TEXT PRIMARY KEY,github_login TEXT)'); await db.query('CREATE TABLE sessions(id TEXT PRIMARY KEY,user_id TEXT,expires_at BIGINT)');
  await db.query('INSERT INTO users VALUES($1,$1)', ['alice']); await db.query('INSERT INTO sessions VALUES($1,$2,$3)', ['session', 'alice', Date.now() + 60_000]);
  registry = createRegistry(db, { domain: 'connect.example.com', accountUrl: origin }); api = createConnectApi({ registry, db, sessionSecret: secret });
});
afterEach(() => db.close());
const call = (path: string, body?: unknown, headers = {}) => api.dispatch(new Request(`${origin}/api/connect${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
it('starts direct browser navigation only for a signed-in owner through a same-origin request', async () => {
  const owned = await registry.reserveComputer('alice', 'alice-mac');
  const other = await registry.reserveComputer('bob', 'bob-mac');
  const body = { serverId: owned.serverId };
  expect((await call('/browser/open', body)).status).toBe(401);
  expect((await call('/browser/open', body, { cookie })).status).toBe(403);
  expect((await call('/browser/open', body, { cookie, origin: 'https://evil.com' })).status).toBe(403);
  for (const serverId of [undefined, 42, 'missing', other.serverId]) {
    expect((await call('/browser/open', { serverId }, { cookie, origin })).status).toBe(403);
  }
  const result = await call('/browser/open', body, { cookie, origin });
  expect(result.status).toBe(200);
  expect((await result.json()).location).toMatch(/^https:\/\/alice-mac\.connect\.example\.com\/_connect\/login\?intent=/);
  expect(result.headers.get('set-cookie')).toMatch(/^zcc_connect_open=[\w-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=120; Secure$/);
  await registry.revoke('alice', 'server', owned.serverId);
  expect((await call('/browser/open', body, { cookie, origin })).status).toBe(403);
});
it('authorizes browser/native discovery and device management without accepting another cookie origin', async () => {
  const start = await registry.startEnrollment('Laptop');
  expect((await call(`/device/info?code=${start.userCode}`, undefined, { cookie })).status).toBe(200);
  expect((await call('/device/approve', { code: start.userCode, approved: true }, { cookie })).status).toBe(403);
  expect((await call('/device/approve', { code: start.userCode, approved: 'yes' }, { cookie, origin })).status).toBe(400);
  await registry.approveEnrollment('alice', start.userCode);
  const enrolled = await registry.pollEnrollment(start.deviceCode); const authorization = `Bearer ${enrolled.credential}`;
  expect((await (await call('/servers', undefined, { authorization })).json()).servers).toHaveLength(1);
  expect((await (await call('/servers', undefined, { cookie })).json()).servers).toHaveLength(1);
  expect((await call('/servers', undefined, { authorization: 'Bearer bad' })).status).toBe(401);
  expect((await (await call('/devices', undefined, { authorization })).json()).devices).toEqual([]);
  expect((await call('/revoke', { kind: 'unknown', id: 'x' }, { authorization })).status).toBe(400);
  expect((await call('/revoke', { kind: 'server', id: enrolled.serverId }, { cookie, origin })).status).toBe(200);
  expect((await call('/devices', undefined, { authorization })).status).toBe(401);
  expect((await call('/missing')).status).toBe(404);
});
it('rejects malformed inputs, bad/expired cookie signatures and rate-limits unauthenticated enrollment', async () => {
  for (const value of ['', 'zcc_session=no-dot', 'zcc_session=session.bad', `zcc_session=${'x'.repeat(300)}`]) expect(await browserAccount(db, value, secret)).toBeNull();
  expect(await browserAccount(db, cookie, '')).toBeNull();
  expect(await browserAccount(db, cookie, secret, Date.now() + 120_000)).toBeNull();
  expect((await call('/device/poll', { deviceCode: 'bad' })).status).toBe(400);
  expect((await api.dispatch(new Request('https://evil.com/api/connect/account'))).status).toBe(403);
  for (const raw of ['[]', 'null', '{']) await expect(readJson(new Request(origin, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw }))).rejects.toMatchObject({ status: 400 });
  await expect(readJson(new Request(origin, { method: 'POST', body: '{}' }))).rejects.toMatchObject({ status: 415 });
  await expect(readJson(new Request(origin, { method: 'POST', headers: { 'content-type': 'application/json' } }))).rejects.toMatchObject({ status: 400 });
  for (let i = 0; i < 30; i++) expect((await call('/device/start', { name: 'x' })).status).toBe(200);
  expect((await call('/device/start', { name: 'x' })).status).toBe(429);
  const broken = createConnectApi({ registry: { ...registry, startEnrollment: async () => { throw new Error('secret database details'); } }, db, sessionSecret: secret });
  const error = await broken.dispatch(new Request(`${origin}/api/connect/device/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"Mac"}' }));
  expect(error.status).toBe(503); expect(await error.text()).not.toContain('secret');
});

it('requires a signed-in owner and same-origin mutation to claim an address', async () => {
  const start = await registry.startEnrollment('Laptop'); await registry.approveEnrollment('alice', start.userCode);
  const enrolled = await registry.pollEnrollment(start.deviceCode);
  const body = { serverId: enrolled.serverId, label: 'alice-mac' };
  expect((await call('/address?label=alice-mac')).status).toBe(401);
  expect((await call('/address', body, { authorization: `Bearer ${enrolled.credential}` })).status).toBe(401);
  expect((await call('/address', body, { cookie })).status).toBe(403);
  expect((await call('/address', { ...body, serverId: 3 }, { cookie, origin })).status).toBe(400);
  expect((await call('/address', { ...body, label: 'admin' }, { cookie, origin })).status).toBe(400);
  expect((await call('/address', body, { cookie, origin })).status).toBe(200);
  expect((await (await call('/account', undefined, { cookie })).json()).domain).toBe('connect.example.com');
});

it('issues computer codes only to a signed-in browser owner with same-origin protection', async () => {
  expect((await call('/computer/code', {})).status).toBe(401);
  expect((await call('/computer/code', {}, { cookie })).status).toBe(403);
  expect((await call('/computer/code', {}, { cookie, origin: 'https://evil.com' })).status).toBe(403);
  const issued = await call('/computer/code', {}, { cookie, origin });
  expect(issued.status).toBe(200); const { code } = await issued.json();
  expect((await call('/computer/redeem', { code, name: 'Mac' }, { origin: 'https://evil.com' })).status).toBe(403);
  const result = await call('/computer/redeem', { code, name: 'Mac' });
  expect(result.status).toBe(200);
  expect(await registry.authenticateServer((await result.json()).credential)).toMatchObject({ user_id: 'alice' });
  expect((await call('/computer/redeem', { code, name: 'Again' })).status).toBe(409);
  expect((await call('/computer/code', {}, { authorization: 'Bearer machine-credential' })).status).toBe(401);
});
it('rate-limits guesses separately from authenticated code generation', async () => {
  for (let i = 0; i < 30; i++) expect((await call('/computer/redeem', { code: 'AAAAAAAAAAAAAAAA', name: 'Guess' })).status).toBe(409);
  expect((await call('/computer/redeem', { code: 'AAAAAAAAAAAAAAAA', name: 'Guess' })).status).toBe(429);
  for (let i = 0; i < 30; i++) expect((await call('/computer/code', {}, { cookie, origin })).status).toBe(200);
  expect((await call('/computer/code', {}, { cookie, origin })).status).toBe(429);
});

it('limits account execution-machine summaries to an owned, live registration', async () => {
  const enrolled = await registry.redeemComputerCode((await registry.createComputerCode('alice')).code, 'Primary');
  const server = await registry.authenticateServer(enrolled.credential);
  const issued = await registry.createMachineCode(server, { instanceId: randomUUID(), hostId: randomUUID(), name: 'Devbox', enrollToken: `zcde_${randomBytes(18).toString('base64url')}` });
  await registry.redeemMachineCode(issued.code, randomBytes(32).toString('base64url'));
  const path = `/account/hosts?serverId=${server.id}`;
  expect((await call(path)).status).toBe(401);
  expect((await call(path, undefined, { authorization: `Bearer ${enrolled.credential}` })).status).toBe(401);
  const owned = await call(path, undefined, { cookie });
  expect(owned.status).toBe(200);
  const body = await owned.json();
  expect(body.machines).toHaveLength(1);
  expect(body.machines[0]).toMatchObject({ name: 'Devbox' });
  expect(JSON.stringify(body)).not.toContain('credential');
  const other = await registry.redeemComputerCode((await registry.createComputerCode('bob')).code, 'Other');
  expect((await call(`/account/hosts?serverId=${other.serverId}`, undefined, { cookie })).status).toBe(403);
  expect((await call('/account/hosts', undefined, { cookie })).status).toBe(403);
  await registry.revoke('alice', 'server', server.id);
  expect((await call(path, undefined, { cookie })).status).toBe(403);
});

it('requires an authenticated same-origin reservation and exposes only its pairing state', async () => {
  expect((await call('/computer/reserve', { label: 'my-mac' })).status).toBe(401);
  expect((await call('/computer/reserve', { label: 'my-mac' }, { cookie })).status).toBe(403);
  const reservation = await call('/computer/reserve/', { label: 'my-mac' }, { cookie, origin });
  expect(reservation.status).toBe(200);
  const reserved = await reservation.json();
  const account = await (await call('/account', undefined, { cookie })).json();
  expect(account.servers).toEqual([expect.objectContaining({ id: reserved.serverId, paired: false, live: false, browserUrl: reserved.browserUrl })]);
  expect(JSON.stringify(account)).not.toMatch(/credential|hash|code/);
  const another = await registry.reserveComputer('bob', 'bobs-mac');
  expect((await call('/computer/code', { serverId: another.serverId }, { cookie, origin })).status).toBe(404);
  const renewed = await (await call('/computer/code', { serverId: reserved.serverId }, { cookie, origin })).json();
  expect((await call('/computer/redeem', { code: reserved.code, name: 'Old' })).status).toBe(409);
  expect((await call('/computer/redeem', { code: renewed.code, name: 'My Mac' })).status).toBe(200);
  expect((await call('/computer/code', { serverId: reserved.serverId }, { cookie, origin })).status).toBe(409);
});
