import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { getHost } from '@zana-ai/zcc-db';
import { CLI_CALLBACK_MAX_BODY_BYTES, CLI_CALLBACK_MAX_RESPONSE_BYTES } from '@zana-ai/zcc-contracts/cli-callbacks';
import { CliCallbackAuthority, createProductCliCallbackAuthority } from './cli-callback-authority.js';
vi.mock('@zana-ai/zcc-db', () => ({ getHost: vi.fn(() => ({ id: 'host' })) }));
const grant = { projectId: 'project', sessionId: '11111111-1111-4111-8111-111111111111', credential: 'a'.repeat(64) };
const input = { sessionId: grant.sessionId, path: `/mcp/project/${grant.sessionId}/${grant.credential}`, headers: { accept: 'application/json' }, bodyBase64: Buffer.from('{}').toString('base64') };
function fixture(patch: object = {}) {
  const owner = { projectId: grant.projectId, hostId: 'host', daemonInstanceId: 'daemon', active: true };
  const fetcher = vi.fn(async () => new Response('answer', { headers: { 'content-type': 'application/json' } }));
  const options = { owner: vi.fn((_id: string) => owner), mcpBaseUrl: () => 'http://127.0.0.1:4444', fetch: fetcher as typeof fetch, ...patch };
  const authority = new CliCallbackAuthority(options); authority.register(grant);
  return { authority, owner, options, fetcher, forward: (request: unknown = input, host = 'host', signal = new AbortController().signal) => authority.forward(host, request, signal) };
}
it('forwards only the registered session to the main-owned loopback address and returns bounded bytes', async () => {
  const f = fixture(); f.authority.register(grant);
  expect(await f.forward()).toEqual({ status: 200, contentType: 'application/json', bodyBase64: Buffer.from('answer').toString('base64') });
  expect(f.fetcher).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:4444' + input.path, expect.objectContaining({ method: 'POST', headers: input.headers, body: new Uint8Array(Buffer.from('{}')), redirect: 'error', signal: expect.any(AbortSignal) }));
  f.authority.revoke(grant.sessionId); await expect(f.forward()).rejects.toThrow('not authorized');
});
it.each([
  { projectId: 'other' }, { hostId: 'other' }, { daemonInstanceId: 'restarted' }, { active: false }
])('rejects changed authoritative ownership before and after a request: %j', async patch => {
  const f = fixture(); Object.assign(f.owner, patch); await expect(f.forward()).rejects.toThrow('not authorized'); expect(f.fetcher).not.toHaveBeenCalled();
  const during = fixture(); during.fetcher.mockImplementationOnce(async () => { Object.assign(during.owner, patch); return new Response('answer'); });
  await expect(during.forward()).rejects.toThrow('ownership changed');
});
it('rejects a wrong host, another callback route, missing session and changed credential', async () => {
  const f = fixture();
  await expect(f.forward(input, 'different')).rejects.toThrow('not authorized');
  await expect(f.forward({ ...input, path: '/api/v1/projects' })).rejects.toThrow('not authorized');
  await expect(f.forward({ ...input, sessionId: randomUUID() })).rejects.toThrow('not authorized');
  expect(() => f.authority.register({ ...grant, credential: 'b'.repeat(64) })).toThrow('cannot be replaced');
  f.owner.active = false; expect(() => f.authority.register(grant)).toThrow('ownership');
  f.authority.dispose(); expect(() => f.authority.register(grant)).toThrow('closed');
  f.authority.revoke('unknown'); expect(f.fetcher).not.toHaveBeenCalled();
});
it('requires canonical bounded base64 and closed headers', async () => {
  const f = fixture();
  for (const bodyBase64 of ['Zh==', Buffer.alloc(CLI_CALLBACK_MAX_BODY_BYTES + 1).toString('base64')]) await expect(f.forward({ ...input, bodyBase64 })).rejects.toThrow();
  await expect(f.forward({ ...input, headers: { authorization: 'Bearer secret' } })).rejects.toThrow();
  expect(f.fetcher).not.toHaveBeenCalled();
});
it.each([null, 'https://remote.invalid', 'http://localhost:9', 'http://user@127.0.0.1', 'http://127.0.0.1/path', 'http://127.0.0.1/?query', 'http://127.0.0.1/#fragment'])('rejects an absent or non-owner destination: %s', async base => {
  const f = fixture({ mcpBaseUrl: () => base }); await expect(f.forward()).rejects.toThrow(); expect(f.fetcher).not.toHaveBeenCalled();
});
it('bounds declared and streamed replies, including malformed lengths', async () => {
  const f = fixture();
  for (const length of ['invalid', String(CLI_CALLBACK_MAX_RESPONSE_BYTES + 1)]) {
    f.fetcher.mockResolvedValueOnce(new Response('x', { headers: { 'content-length': length } })); await expect(f.forward()).rejects.toThrow('limit');
  }
  f.fetcher.mockResolvedValueOnce(new Response('x'.repeat(CLI_CALLBACK_MAX_RESPONSE_BYTES + 1))); await expect(f.forward()).rejects.toThrow('limit');
  f.fetcher.mockResolvedValueOnce(new Response(null, { status: 204 })); expect(await f.forward()).toEqual({ status: 204, bodyBase64: '' });
});
it('cancels active fetches on revocation and never retries a failed mutation', async () => {
  const f = fixture(); let signal: AbortSignal | undefined;
  f.fetcher.mockImplementationOnce(((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
    signal = init.signal!; signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  })) as never);
  const result = f.forward(); f.authority.revoke(grant.sessionId);
  await expect(result).rejects.toThrow('aborted'); expect(signal?.aborted).toBe(true); expect(f.fetcher).toHaveBeenCalledOnce();
});
it('cancels an offline host without erasing a still-current grant for its reconnect', async () => {
  const f = fixture();
  f.fetcher.mockImplementationOnce(((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
    init.signal!.addEventListener('abort', () => reject(new Error('offline')), { once: true });
  })) as never);
  const result = f.forward(); f.authority.abortHost('other'); f.authority.abortHost('host');
  await expect(result).rejects.toThrow('offline');
  expect((await f.forward()).status).toBe(200);
});
it('bounds both retained grants and concurrent calls, reclaiming inactive grants', async () => {
  const f = fixture(); for (let i = 0; i < 127; i++) f.authority.register({ ...grant, sessionId: randomUUID() });
  expect(() => f.authority.register({ ...grant, sessionId: randomUUID() })).toThrow('capacity');
  const ownerFn = f.options.owner; ownerFn.mockImplementation(id => id === grant.sessionId ? f.owner : undefined as never);
  f.authority.register(grant); // An identical registration does not widen the grant.
  ownerFn.mockReturnValue(f.owner);
  const held: Array<(value: Response) => void> = [];
  f.fetcher.mockImplementation(() => new Promise<Response>(resolve => held.push(resolve)));
  const pending = Array.from({ length: 8 }, () => f.forward());
  await expect(f.forward()).rejects.toThrow('capacity');
  held.forEach(resolve => resolve(new Response('ok'))); await Promise.all(pending);
  f.authority.dispose();
  const owners = new Map([[grant.sessionId, f.owner]]);
  const reclaim = new CliCallbackAuthority({ owner: id => owners.get(id), mcpBaseUrl: () => null });
  reclaim.register(grant); owners.delete(grant.sessionId);
  const next = randomUUID(); owners.set(next, f.owner); reclaim.register({ ...grant, sessionId: next });
});
it('rejects a pre-cancelled request without touching the callback server', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  await expect(f.forward(input, 'host', controller.signal)).rejects.toThrow(); expect(f.fetcher).not.toHaveBeenCalled();
});
it('derives active ownership from product records, current enrollment, and registered projects', () => {
  const session = { id: grant.sessionId, projectId: 'project', hostId: 'host', daemonInstanceId: 'daemon', profile: 'claude', status: 'running' };
  const ctx = { terminalSessions: new Map([[grant.sessionId, session]]), projects: { list: () => [{ id: 'project' }] }, hostHub: { getSession: () => ({ instanceId: 'daemon' }) }, db: {} };
  const register = () => createProductCliCallbackAuthority(ctx as never, () => null).register(grant);
  expect(register).not.toThrow();
  for (const patch of [{ profile: 'shell' }, { status: 'exited' }, { daemonInstanceId: '' }, { daemonInstanceId: 'other' }, { projectId: 'removed' }]) {
    ctx.terminalSessions.set(grant.sessionId, { ...session, ...patch }); expect(register).toThrow('ownership');
  }
  ctx.terminalSessions.clear(); expect(register).toThrow('ownership'); ctx.terminalSessions.set(grant.sessionId, session);
  vi.mocked(getHost).mockReturnValueOnce(undefined as never); expect(register).toThrow('ownership');
  vi.mocked(getHost).mockReturnValueOnce({ destroyedAt: 'now' } as never); expect(register).toThrow('ownership');
});
