import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { openConnectDatabase } from '../connect/database.mjs';
import { createRegistry } from '../connect/registry.mjs';
import { createSlackService } from './service.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

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
afterEach(async () => { await service?.close(); await db?.close(); });
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
const actor = { user_id: 'U123456', team_id: identity.team, enterprise_id: null };
const task = { project_id: 'p1', channel_id: 'C123456', task: 'Review this change', request_id: 'request_001' };
const rpc = (name: string, args: any = {}, who: any = actor) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args, _meta: { slack: who } } });
async function mcp(body: any, headers = {}, raw = JSON.stringify(body)) {
  const time = String(Math.floor(clock / 1000));
  return service.dispatch(new Request('https://example.com/api/slack/mcp/', { method: 'POST', headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': time, 'x-slack-signature': `v0=${createHmac('sha256', signing).update(`v0:${time}:${raw}`).digest('hex')}`, ...headers }, body: raw }));
}
const data = async (body: any) => (await (await mcp(body)).json()).result;
const toolDispatch = () => dispatch.mockImplementation(async ({ payload }: any) => {
  const p = JSON.parse(payload.body);
  return { status: 200, body: { accepted: true, response: p.name === 'zana_list_projects' ? { projects: [{ project_id: 'p1' }] } : { job_id: p.requestId, state: p.name === 'zana_launch_job' ? 'queued' : 'running' } } };
});

it('supports real MCP SDK initialization, discovery, ping and calls over stateless HTTP', async () => {
  await link(); toolDispatch();
  const client = new Client({ name: 'slackbot-test', version: '1.0' });
  const transport = new StreamableHTTPClientTransport(new URL('https://example.com/api/slack/mcp/'), { fetch: async (_url, init) => {
    if (init?.method === 'GET' || init?.method === 'DELETE') return service.dispatch(new Request('https://example.com/api/slack/mcp/', { method: init.method }));
    return mcp(JSON.parse(String(init?.body)), Object.fromEntries(new Headers(init?.headers)));
  } });
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools.map(t => t.name)).toEqual(['zana_connect', 'zana_list_projects', 'zana_import_project', 'zana_launch_options', 'zana_launch_job', 'zana_job_status', 'zana_list_capabilities', 'zana_run_capability']);
    await client.ping();
    expect(await client.callTool({ name: 'zana_list_projects', arguments: {}, _meta: { slack: actor } })).toMatchObject({ structuredContent: { projects: [{ project_id: 'p1' }] } });
  } finally { await client.close(); }
  expect((await (await mcp({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: 'future' } })).json()).result.protocolVersion).toBe('2025-11-25');
});

it('authenticates the raw body and signed identity, rejects forged arguments and needs a live link', async () => {
  expect((await mcp(rpc('zana_list_projects'), { 'x-slack-signature': 'bad' })).status).toBe(401);
  expect((await mcp(rpc('zana_list_projects'), { 'x-slack-request-timestamp': '1000000000' })).status).toBe(401);
  for (const who of [null, {}, { ...actor, team_id: null, enterprise_id: 'E123456' }, { ...actor, team_id: 'T987654' }, { ...actor, user_id: 'bad' }]) expect(await data(rpc('zana_list_projects', {}, who))).toMatchObject({ isError: true, structuredContent: { error: 'wrong_identity' } });
  expect(await data(rpc('zana_list_projects'))).toMatchObject({ structuredContent: { error: 'not_connected' } });
  await link(); dispatch.mockClear();
  for (const args of [{ ...task, user_id: 'U234567' }, { ...task, task: ' ' }, { ...task, task: 'x'.repeat(2001) }, { ...task, request_id: 'bad' }, { ...task, channel_id: '../private' }, [], { ...task, project_id: 3 }]) expect(await (await mcp(rpc('zana_launch_job', args))).json()).toMatchObject({ error: { code: -32602 } });
  expect(await (await mcp(rpc('zana_job_status'))).json()).toMatchObject({ error: { code: -32602 } });
  expect(dispatch).not.toHaveBeenCalled();
});

it('connects each Slack caller to an owned domain only after account and local approval', async () => {
  const a = await server('alice'), other = await server('alice'), b = await server('bob');
  await connect.claimAddress('alice', a.serverId, 'alice-work');
  await connect.claimAddress('bob', b.serverId, 'bob-work');
  const response = await data(rpc('zana_connect', { domain: 'https://alice-work.connect.example.com/' }));
  expect(response.structuredContent).toMatchObject({ status: 'approval_required', domain: 'alice-work.connect.example.com', expires_in_seconds: 600 });
  const code = new URL(response.structuredContent.connect_url).searchParams.get('slack');
  expect(new URL(response.structuredContent.connect_url).origin).toBe('https://example.com');
  expect(dispatch).not.toHaveBeenCalled();
  expect(await service.registry.owner(actor.user_id)).toBeUndefined();
  expect((await api(`info?code=${code}`, undefined, undefined, 'bob')).status).toBe(403);
  expect((await api(`info?code=${code}`, undefined, undefined, 'unknown')).status).toBe(401);
  expect(await (await api(`info?code=${code}`)).json()).toMatchObject({ domain: 'alice-work.connect.example.com', serverId: a.serverId, userId: actor.user_id });
  expect((await api('approve', { code, serverId: other.serverId, approved: true })).status).toBe(403);
  expect((await api('approve', { code, serverId: b.serverId, approved: true }, undefined, 'bob')).status).toBe(403);
  const approved = await (await api('approve', { code, serverId: a.serverId, approved: true })).json();
  expect(await service.registry.owner(actor.user_id)).toBeUndefined();
  const grant = await (await api('redeem', { code: approved.activationCode })).json();
  expect((await api('activate', {}, grant.credential)).status).toBe(200);
  const bobResponse = await data(rpc('zana_connect', { domain: 'bob-work' }, { ...actor, user_id: 'U234567' }));
  const bobCode = new URL(bobResponse.structuredContent.connect_url).searchParams.get('slack');
  const bobApproved = await (await api('approve', { code: bobCode, serverId: b.serverId, approved: true }, undefined, 'bob')).json();
  const bobGrant = await (await api('redeem', { code: bobApproved.activationCode })).json();
  expect((await api('activate', {}, bobGrant.credential)).status).toBe(200);
  dispatch.mockClear(); toolDispatch();
  await data(rpc('zana_list_projects'));
  await data(rpc('zana_list_projects', {}, { ...actor, user_id: 'U234567' }));
  expect(dispatch.mock.calls.map(([request]: any) => [request.accountId, request.serverId])).toEqual([['alice', a.serverId], ['bob', b.serverId]]);
});

it('keeps domain lookup private and rejects revoked, unpaired, invalid and expired connections', async () => {
  const a = await server('alice');
  await connect.claimAddress('alice', a.serverId, 'alice-work');
  for (const name of ['alice-work', 'unknown-domain']) {
    const response = await data(rpc('zana_connect', { domain: name }));
    expect(response.structuredContent.status).toBe('approval_required');
  }
  expect(await data(rpc('zana_connect', { domain: 'https://evil.example/' }))).toMatchObject({ isError: true, structuredContent: { error: 'invalid_domain' } });
  expect(await data(rpc('zana_connect', {}, { ...actor, user_id: 'invalid' }))).toMatchObject({ structuredContent: { error: 'wrong_identity' } });
  expect((await mcp(rpc('zana_connect'), { 'x-slack-signature': 'bad' })).status).toBe(401);
  await expect(service.registry.start(actor.user_id, 'invalid/domain')).rejects.toThrow('invalid_domain');
  const generic = await data(rpc('zana_connect'));
  expect(generic.structuredContent).not.toHaveProperty('domain');
  const code = await service.registry.start(actor.user_id, 'alice-work');
  await db.query('UPDATE connect_servers SET credential_hash=NULL WHERE id=$1', [a.serverId]);
  expect((await api(`info?code=${code}`)).status).toBe(403);
  expect((await api('approve', { code, serverId: a.serverId, approved: true })).status).toBe(403);
  await connect.revoke('alice', 'server', a.serverId);
  expect((await api(`info?code=${code}`)).status).toBe(403);
  expect((await api('approve', { code, serverId: a.serverId, approved: true })).status).toBe(403);
  clock += 600_001;
  expect((await api(`info?code=${code}`)).status).toBe(410);
  await service.registry.prune();
  expect(await db.query('SELECT * FROM slack_link_domains')).toHaveLength(0);
});

it('launches once across concurrent retries and restarts, checks payload conflicts, and isolates two owners', async () => {
  const a = await link(), b = await link('bob', 'U234567'); dispatch.mockClear(); toolDispatch();
  const [one, two] = await Promise.all([data(rpc('zana_launch_job', task)), data({ ...rpc('zana_launch_job', task), id: 2 })]);
  expect(one.structuredContent.job_id).toBe(two.structuredContent.job_id);
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(dispatch.mock.calls[0][0]).toMatchObject({ accountId: 'alice', serverId: a.serverId });
  expect(await data(rpc('zana_launch_job', Object.fromEntries(Object.entries(task).reverse())))).toEqual(one);
  expect(dispatch).toHaveBeenCalledTimes(1);
  const job = one.structuredContent.job_id;
  expect(await data(rpc('zana_job_status', { job_id: job }))).toMatchObject({ structuredContent: { state: 'running' } });
  expect(await data(rpc('zana_launch_job', { ...task, task: 'different' }))).toMatchObject({ structuredContent: { error: 'request_conflict' } });
  expect(await data(rpc('zana_job_status', { job_id: job }, { ...actor, user_id: 'U234567' }))).toMatchObject({ structuredContent: { error: 'job_not_found' } });
  await data(rpc('zana_launch_job', task, { ...actor, user_id: 'U234567' }));
  expect(dispatch.mock.calls.at(-1)[0].serverId).toBe(b.serverId);
  await service.close();
  service = await createSlackService({ db, connect, dispatchPlugin: dispatch, pluginId: 'test-plugin', sessionSecret: secret, signingSecret: signing, identity, call, now: () => clock });
  dispatch.mockClear();
  expect(await data(rpc('zana_launch_job', task))).toEqual(one);
  expect(dispatch).not.toHaveBeenCalled();
  await api('unlink', {}, a.credential);
  expect(await data(rpc('zana_job_status', { job_id: job }))).toMatchObject({ structuredContent: { error: 'not_connected' } });
});

it('keeps uncertain launches for review, recovers local status and never resends them', async () => {
  await link(); dispatch.mockClear();
  dispatch.mockRejectedValueOnce(new Error('lost response'));
  const first = await data(rpc('zana_launch_job', task));
  expect(first).toMatchObject({ isError: true, structuredContent: { error: 'needs_review', job_id: expect.any(String) } });
  expect(await data(rpc('zana_launch_job', task))).toEqual(first);
  expect(dispatch).toHaveBeenCalledTimes(1);
  toolDispatch();
  expect(await data(rpc('zana_job_status', { job_id: first.structuredContent.job_id }))).toMatchObject({ structuredContent: { state: 'running' } });
  dispatch.mockRejectedValueOnce(new Error('computer_offline'));
  expect(await data(rpc('zana_job_status', { job_id: first.structuredContent.job_id }))).toMatchObject({ structuredContent: { error: 'status_unavailable' } });
  dispatch.mockRejectedValueOnce(new Error('computer_offline'));
  const second = await data(rpc('zana_launch_job', { ...task, request_id: 'request_002' }));
  expect(second).toMatchObject({ structuredContent: { error: 'not_started' } });
  dispatch.mockClear();
  expect(await data(rpc('zana_job_status', { job_id: second.structuredContent.job_id }))).toEqual(second);
  expect(dispatch).not.toHaveBeenCalled();
  dispatch.mockResolvedValueOnce({ status: 503, body: { notStarted: true } });
  expect(await data(rpc('zana_launch_job', { ...task, request_id: 'request_003' }))).toMatchObject({ structuredContent: { error: 'not_started' } });
  dispatch.mockResolvedValueOnce({ status: 504, body: { notStarted: false } });
  expect(await data(rpc('zana_launch_job', { ...task, request_id: 'request_004' }))).toMatchObject({ structuredContent: { error: 'needs_review' } });
  await db.query("UPDATE slack_mcp_requests SET state='dispatching',response=NULL WHERE id=$1", [first.structuredContent.job_id]);
  await service.close();
  service = await createSlackService({ db, connect, dispatchPlugin: dispatch, pluginId: 'test-plugin', sessionSecret: secret, signingSecret: signing, identity, call, now: () => clock });
  expect(await data(rpc('zana_launch_job', task))).toMatchObject({ structuredContent: { error: 'needs_review' } });
  clock += 31 * 86400_000; await service.registry.prune();
  expect(await db.query('SELECT * FROM slack_mcp_requests')).toHaveLength(0);
});

it('bounds the protocol and enforces origin, content type, version, notification and malformed-message behavior', async () => {
  expect((await service.dispatch(new Request('https://example.com/api/slack/mcp'))).status).toBe(405);
  expect((await mcp({}, { origin: 'https://evil.example' })).status).toBe(403);
  expect((await mcp({}, { 'mcp-protocol-version': 'future' })).status).toBe(400);
  expect((await mcp({}, { 'content-type': 'text/plain' })).status).toBe(415);
  expect((await mcp({}, {}, 'x'.repeat(300_000))).status).toBe(413);
  expect(await (await mcp({}, {}, 'invalid')).json()).toMatchObject({ error: { code: -32700 } });
  for (const message of [[], null, {}, { jsonrpc: '2.0', id: {}, method: 'ping' }, { jsonrpc: '2.0', id: 1, method: 'ping', params: [] }]) expect(await (await mcp(message)).json()).toMatchObject({ error: { code: -32600 } });
  expect((await mcp({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
  expect(await (await mcp({ jsonrpc: '2.0', id: 'hello', method: 'unknown' })).json()).toMatchObject({ id: 'hello', error: { code: -32601 } });
  expect(await (await mcp(rpc('bad'))).json()).toMatchObject({ error: { code: -32602 } });
});


it('forwards imports and plugin capabilities only to each signed caller’s linked computer', async () => {
  const alice = await link(), bob = await link('bob', 'U234567');
  dispatch.mockClear();
  for (const [name, args] of [
    ['zana_import_project', { project_id: 'p2' }],
    ['zana_list_capabilities', {}],
    ['zana_run_capability', { capability_id: 'tickets.inspect', arguments_json: '{"project_id":"p1","query":"item"}' }],
  ] as const) {
    await data(rpc(name, args)); await data(rpc(name, args, { ...actor, user_id: 'U234567' }));
    const calls = dispatch.mock.calls.slice(-2).map(([request]: any) => [request.accountId, request.serverId, JSON.parse(request.payload.body).name]);
    expect(calls).toEqual([['alice', alice.serverId, name], ['bob', bob.serverId, name]]);
  }
  dispatch.mockClear();
  for (const [name, args] of [['zana_import_project', {}], ['zana_import_project', { project_id: 'p2', user: 'U234567' }], ['zana_run_capability', { capability_id: 'tickets.inspect', arguments_json: 'x'.repeat(8001) }], ['zana_list_capabilities', { plugin: 'secret' }]] as const)
    expect(await (await mcp(rpc(name, args))).json()).toMatchObject({ error: { code: -32602 } });
  expect(dispatch).not.toHaveBeenCalled();
  await service.registry.revoke(alice.link.id, 'alice');
  expect(await data(rpc('zana_import_project', { project_id: 'p2' }))).toMatchObject({ structuredContent: { error: 'not_connected' } });
});
it('describes an interrupted import accurately without creating a launch ledger entry', async () => {
  await link(); dispatch.mockRejectedValue(new Error('lost response'));
  expect(await data(rpc('zana_import_project', { project_id: 'p2' }))).toMatchObject({ structuredContent: { error: 'import_unconfirmed' } });
  expect((await db.query('SELECT COUNT(*) AS n FROM slack_mcp_requests'))[0].n).toBe(0);
});


it('discovers profiles and preserves chosen harness/model in signed idempotent launches', async () => {
  await link();
  await data(rpc('zana_launch_options', {project_id:'p1',harness:'cursor'}));
  expect(JSON.parse(dispatch.mock.calls.at(-1)[0].payload.body)).toMatchObject({name:'zana_launch_options',arguments:{project_id:'p1',harness:'cursor'}});
  dispatch.mockClear();
  const chosen={...task,harness:'cursor',model:'grok-4.6'};
  await data(rpc('zana_launch_job',chosen));
  await data(rpc('zana_launch_job',{model:'grok-4.6',harness:'cursor',...task}));
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(dispatch.mock.calls[0][0].payload.body).arguments).toEqual(chosen);
  expect(await data(rpc('zana_launch_job',{...chosen,model:'another'}))).toMatchObject({structuredContent:{error:'request_conflict'}});
  for(const arguments_ of [{...chosen,harness:3},{...chosen,model:'x'.repeat(151)}]) expect(await (await mcp(rpc('zana_launch_job',arguments_))).json()).toMatchObject({error:{code:-32602}});
});
