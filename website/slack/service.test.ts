import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { openConnectDatabase } from '../connect/database.mjs';
import { createRegistry } from '../connect/registry.mjs';
import { createSlackService } from './service.mjs';
import { createScopedSlack, slackClient } from './api.mjs';
import { envelope, hash, rateLimiter, readBody, verifiedSlack } from './security.mjs';

const identity = { team: 'T123456', app: 'A123456', bot: 'U999999' };
const secret = 'private-session-key'; const signing = 'private-signing-key';
const internal = { id: 'C123456', is_member: true, is_archived: false, is_shared: false, is_ext_shared: false, is_org_shared: false };
let db: any, connect: any, service: any, dispatch: any, call: any, clock: number;
beforeEach(async () => {
  clock = Date.now();
  db = await openConnectDatabase(':memory:', { production: false }); await db.migrate();
  await db.query('CREATE TABLE users(id TEXT PRIMARY KEY,github_login TEXT)'); await db.query('CREATE TABLE sessions(id TEXT PRIMARY KEY,user_id TEXT,expires_at BIGINT)');
  for (const name of ['alice', 'bob']) { await db.query('INSERT INTO users VALUES($1,$1)', [name]); await db.query('INSERT INTO sessions VALUES($1,$1,$2)', [name, clock + 3600_000]); }
  connect = createRegistry(db, { domain: 'connect.example.com', accountUrl: 'https://example.com' });
  call = vi.fn(async (method: string, args: any) => {
    if (method === 'users.info') return { ok: true, user: { id: args.user, real_name: 'Test member' } };
    if (method === 'users.conversations') return { ok: true, channels: [{ id: 'C123456' }] };
    if (method === 'conversations.list') return { ok: true, channels: [internal, { ...internal, id: 'C987654' }] };
    if (method === 'conversations.info') return { ok: true, channel: internal };
    return { ok: true, ts: '1790620000.000001', view: { id: args?.user_id ? `V${args.user_id}` : 'V123456' } };
  });
  dispatch = vi.fn(async (args: any) => ({ status: 200, body: JSON.parse(args.payload.body).kind === 'probe' ? { linkId: args.payload.linkId } : { accepted: true, response: {} } }));
  service = await createSlackService({ db, connect, dispatchPlugin: dispatch, pluginId: 'test-plugin', sessionSecret: secret, signingSecret: signing, identity, call, now: () => clock, intervalMs: 100_000 });
});
afterEach(async () => { await service.close(); await db.close(); });
async function server(owner: string) {
  const code = await connect.startEnrollment(`${owner}'s laptop`); await connect.approveEnrollment(owner, code.userCode, true); return connect.pollEnrollment(code.deviceCode);
}
const cookie = (id: string) => `zcc_session=${id}.${createHmac('sha256', secret).update(id).digest('base64url')}`;
async function api(path: string, input?: any, credential?: string, account = 'alice', extra = {}) {
  return service.dispatch(new Request(`https://example.com/api/connect/slack/${path}`, { method: input === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(credential ? { authorization: `Bearer ${credential}` } : { cookie: cookie(account), origin: 'https://example.com' }), ...extra }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) }));
}
async function link(owner = 'alice', user = 'U123456') {
  const computer = await server(owner); const code = await service.registry.start(user);
  const approved = await (await api('approve', { code, serverId: computer.serverId, approved: true }, undefined, owner)).json();
  const grant = await (await api('redeem', { code: approved.activationCode })).json();
  expect((await api('activate', {}, grant.credential)).status).toBe(200);
  return { ...grant, serverId: computer.serverId, link: await service.registry.owner(user) };
}
function event(user = 'U123456', id = 'Ev1', root?: string) {
  return { type: 'event_callback', event_id: id, team_id: identity.team, api_app_id: identity.app, event: { type: 'app_mention', user, channel: 'C123456', ts: `${Math.floor(clock / 1000)}.000001`, text: '<@U999999> run hello', ...(root ? { thread_ts: root } : {}) } };
}
async function ingress(payload: any, signature = true, form = false) {
  const raw = form ? new URLSearchParams({ payload: JSON.stringify(payload) }).toString() : JSON.stringify(payload);
  const time = String(Math.floor(clock / 1000));
  return service.dispatch(new Request('https://example.com/api/slack/events', { method: 'POST', headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json', 'x-slack-request-timestamp': time, 'x-slack-signature': signature ? `v0=${createHmac('sha256', signing).update(`v0:${time}:${raw}`).digest('hex')}` : 'bad' }, body: raw }));
}
it('requires verified Slack, existing account ownership and a successful probe of the chosen computer', async () => {
  expect((await ingress(event(), false)).status).toBe(401);
  expect(await (await ingress({ type: 'url_verification', challenge: 'challenge' })).json()).toEqual({ challenge: 'challenge' });
  expect((await ingress({ ...event(), team_id: 'T987654' })).status).toBe(403);
  const alice = await server('alice'), bob = await server('bob');
  const code = await service.registry.start('U123456');
  expect((await api(`info?code=${code}`)).status).toBe(200);
  expect((await api('approve', { code, serverId: bob.serverId, approved: true })).status).toBe(403);
  expect((await api('approve', { code, serverId: alice.serverId })).status).toBe(400);
  const approved = await (await api('approve', { code, serverId: alice.serverId, approved: true })).json();
  expect((await api('approve', { code, serverId: alice.serverId, approved: true })).status).toBe(410);
  const grant = await (await api('redeem', { code: approved.activationCode })).json();
  expect((await api('status', {}, grant.credential)).status).toBe(401);
  dispatch.mockResolvedValueOnce({ status: 404, body: {} });
  expect((await api('activate', {}, grant.credential)).status).toBe(409);
  expect((await api('activate', {}, grant.credential)).status).toBe(200);
  expect(dispatch.mock.calls.at(-1)[0]).toMatchObject({ accountId: 'alice', serverId: alice.serverId, pluginId: 'test-plugin' });
  const signed = dispatch.mock.calls.at(-1)[0].payload;
  const { signature, ...message } = signed;
  expect(signature).toBe(createHmac('sha256', grant.credential.split('.')[1]).update(JSON.stringify(message)).digest('hex'));
  expect((await api('activate', {}, grant.credential)).status).toBe(200);
  expect((await api('redeem', { code: approved.activationCode })).status).toBe(410);
  expect((await api('links')).status).toBe(200);
  expect((await api('revoke', { id: grant.linkId }, undefined, 'bob')).status).toBe(404);
  expect((await api('status', {}, `${grant.linkId}.wrong`)).status).toBe(401);
});
it('routes two owners to their own laptops, deduplicates retries and rejects cross-user thread controls', async () => {
  const a = await link(), b = await link('bob', 'U234567'); dispatch.mockClear();
  const first = event(); expect((await ingress(first)).status).toBe(200); await service.drain();
  expect(dispatch).toHaveBeenCalledTimes(1); expect(dispatch.mock.calls[0][0].serverId).toBe(a.serverId);
  await ingress(first); await service.drain(); expect(dispatch).toHaveBeenCalledTimes(1);
  expect((await ingress(event('U234567', 'Ev2', first.event.ts))).status).toBe(403);
  clock += 1000; await ingress(event('U234567', 'Ev3')); await service.drain();
  expect(dispatch.mock.calls.at(-1)[0].serverId).toBe(b.serverId);
  expect((await db.query('SELECT state FROM slack_requests')).map((r: any) => r.state)).toEqual(['delivered', 'delivered']);
  await api('unlink', {}, a.credential);
  expect((await api('call', { method: 'auth.test' }, a.credential)).status).toBe(401);
  expect((await api('status', {}, b.credential)).status).toBe(200);
});
it('distinguishes definitely offline from uncertain execution and never replays either', async () => {
  await link(); dispatch.mockClear(); dispatch.mockRejectedValueOnce(new Error('computer_offline'));
  const first = event(); await ingress(first); await service.drain();
  expect((await db.query('SELECT state FROM slack_requests'))[0].state).toBe('not-started');
  clock += 1000; dispatch.mockRejectedValueOnce(new Error('lost response')); const second = event('U123456', 'Ev2');
  await ingress(second); await service.drain();
  expect((await db.query("SELECT * FROM slack_requests WHERE state='needs-review'"))).toHaveLength(1);
  await ingress(second); await service.drain(); expect(dispatch).toHaveBeenCalledTimes(2);
  expect(call.mock.calls.some((c: any) => c[0] === 'chat.postEphemeral' && c[1].text.includes('unconfirmed'))).toBe(true);
  clock += 1000; dispatch.mockResolvedValueOnce({ status: 504, body: { accepted: false, notStarted: false } });
  await ingress(event('U123456', 'Ev3')); await service.drain();
  expect((await db.query("SELECT * FROM slack_requests WHERE state='needs-review'"))).toHaveLength(2);
});
it('preserves modal acknowledgements, binds triggers and blocks foreign views', async () => {
  const a = await link();
  await service.registry.remember(a.link, 'V123456', 'view');
  const payload = { type: 'view_submission', team: { id: identity.team }, user: { id: 'U123456' }, api_app_id: identity.app, trigger_id: 'trigger', view: { id: 'V123456' } };
  dispatch.mockResolvedValueOnce({ status: 200, body: { accepted: true, response: { response_action: 'errors', errors: { task: 'Required' } } } });
  expect(await (await ingress(payload, true, true)).json()).toMatchObject({ response_action: 'errors' });
  expect(await (await ingress(payload, true, true)).json()).toMatchObject({ response_action: 'errors' });
  expect((await ingress({ ...payload, view: { id: 'VOTHER' } })).status).toBe(403);
  dispatch.mockRejectedValueOnce(new Error('lost response'));
  expect(await (await ingress({ ...payload, trigger_id: 'next' })).json()).toMatchObject({ response_action: 'update', view: { title: { text: 'Check Zana' } } });
});
it('scopes Slack APIs to the owner, membership, owned messages, threads and views', async () => {
  const a = await link(); const proxy = createScopedSlack({ call, registry: service.registry, identity });
  expect(await proxy.proxy(a.link, 'auth.test', {})).toMatchObject({ user_id: identity.bot });
  expect(await proxy.proxy(a.link, 'users.info', { user: 'U123456' })).toHaveProperty('user');
  expect((await proxy.proxy(a.link, 'conversations.list', {})).channels).toHaveLength(1);
  for (const [method, args] of [['users.info', { user: 'U234567' }], ['conversations.info', { channel: 'C987654' }], ['files.upload', {}], ['views.publish', { user_id: 'U234567' }], ['views.open', { trigger_id: 'foreign', view: { type: 'modal' } }], ['chat.update', { channel: 'C123456', ts: '1790620000.000001' }], ['chat.getPermalink', { channel: 'C123456', message_ts: '1790620000.000001' }]]) await expect(proxy.proxy(a.link, method, args)).rejects.toThrow();
  const message = await proxy.proxy(a.link, 'chat.postMessage', { channel: 'C123456', text: 'hello' });
  await proxy.proxy(a.link, 'chat.update', { channel: 'C123456', ts: message.ts, text: 'done' });
  await proxy.proxy(a.link, 'chat.postMessage', { channel: 'C123456', thread_ts: message.ts, text: 'reply' });
  await proxy.proxy(a.link, 'chat.getPermalink', { channel: 'C123456', message_ts: message.ts });
  await proxy.proxy(a.link, 'views.publish', { user_id: 'U123456', view: { type: 'home' } });
  await service.registry.remember(a.link, 'trigger', 'trigger', 3000);
  await proxy.proxy(a.link, 'views.open', { trigger_id: 'trigger', view: { type: 'modal' } });
  await proxy.proxy(a.link, 'views.update', { view_id: 'V123456', view: { type: 'modal' }, hash: 'hash' });
  await proxy.proxy(a.link, 'views.push', { trigger_id: 'trigger', view: { type: 'modal' } });
  clock += 4000;
  await expect(proxy.proxy(a.link, 'views.open', { trigger_id: 'trigger', view: { type: 'modal' } })).rejects.toThrow();
});
it('onboards privately, rejects expired/replaced grants and fails closed after computer revocation', async () => {
  await ingress({ ...event(), event: { type: 'app_home_opened', tab: 'home', user: 'U123456' } });
  await vi.waitFor(() => expect(call.mock.calls.some((c: any) => c[0] === 'views.publish' && c[1].view.blocks.at(-1).type === 'actions')).toBe(true));
  const a = await link(); const old = a.credential;
  const code = await service.registry.start('U123456'); const bob = await server('bob');
  expect((await api('approve', { code, serverId: bob.serverId, approved: true }, undefined, 'bob')).status).toBe(409);
  const replacement = await link(); expect((await api('status', {}, old)).status).toBe(401);
  await connect.revoke('alice', 'server', replacement.serverId);
  expect((await api('status', {}, replacement.credential)).status).toBe(401);
  clock += 700_000; expect((await api(`info?code=${code}`)).status).toBe(410);
  await service.registry.prune();
});
it('bounds and validates the HTTP surface, cookies, origins, bodies and signatures', async () => {
  expect((await api('links', undefined, undefined, 'unknown')).status).toBe(401);
  expect((await api('revoke', {}, undefined, 'alice', { origin: 'https://evil.example' })).status).toBe(403);
  expect((await api('nonesuch')).status).toBe(404);
  expect((await api('redeem', { code: 'bad' })).status).toBe(400);
  expect((await api('info?code=bad')).status).toBe(400);
  expect((await service.dispatch(new Request('https://other.example/api/connect/slack/links'))).status).toBe(503);
  await expect(readBody(new Request('https://example.com', { method: 'POST', body: 'a'.repeat(300_000) }))).rejects.toThrow('body_too_large');
  expect(verifiedSlack(Buffer.from(''), new Headers(), signing)).toBe(false);
  expect(envelope({ id: 'id' }, secret, {}).signature).toHaveLength(64);
  const limited = rateLimiter(() => clock); limited('one', 1); expect(() => limited('one', 1)).toThrow(); clock += 60_000; expect(() => limited('one', 1)).not.toThrow();
});
it('bounds direct Slack responses and never retries an ambiguous write', async () => {
  const fetcher = vi.fn(async () => Response.json({ ok: true }));
  const client = slackClient('private', fetcher);
  await client('chat.postMessage', { text: 'hi' }); expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
  await expect(client('../bad')).rejects.toThrow();
  await expect(client('chat.postMessage', { text: 'x'.repeat(300_000) })).rejects.toThrow();
  fetcher.mockResolvedValueOnce(new Response('error', { status: 429 })); await expect(client('auth.test')).rejects.toThrow('slack_rate_limited');
  fetcher.mockResolvedValueOnce(new Response('x'.repeat(300_000))); await expect(client('auth.test')).rejects.toThrow('slack_response_too_large');
  fetcher.mockResolvedValueOnce(Response.json({ ok: false, error: 'invalid_auth' })); expect(await client('auth.test')).toEqual({ ok: false, error: 'invalid_auth' });
});
