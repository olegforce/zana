import { generateKeyPairSync, verify } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createClient, findBetaGroup, parseArgs, signJwt, waitForBuild } from './testflight-distribute.mjs';
const auth = { keyId: 'KEY1234567', issuerId: 'issuer', privateKey: generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey };
const options = { appId: '123', version: '2.3.0', build: '42', timeoutMinutes: 1 };
const build = (state = 'VALID', expired = false) => ({ data: [{ id: 'build-id', attributes: { version: '42', processingState: state, expired }, relationships: { betaGroups: { data: [{ id: 'group-id' }] }, betaAppReviewSubmission: { data: { id: 'review-id' } } } }], included: [{ id: 'review-id', type: 'betaAppReviewSubmissions', attributes: { betaReviewState: 'APPROVED' } }] });
it('validates explicit versions, builds, timeouts and unknown flags', () => {
  expect(parseArgs(['--version', '2.3.0', '--build', '42', '--group', 'Beta', '--key-path', '/tmp/key', '--timeout-minutes', '1'])).toMatchObject({ version: '2.3.0', build: '42', group: 'Beta', timeoutMinutes: 1 });
  expect(parseArgs(['--version', '2.3.0', '--build', '42.1']).build).toBe('42.1');
  for (const args of [[], ['--version', 'bad'], ['--version', '2.3.0', '--build', 'bad'], ['--version', '2.3.0', '--build', '42', '--group', ''], ['--version', '2.3.0', '--build', '42', '--timeout-minutes', '121'], ['--unknown', 'x']]) expect(() => parseArgs(args)).toThrow();
});
it('signs a short lived ES256 token and refuses redirects or credential-bearing error output', async () => {
  const token = signJwt(auth); const [header, body, signature] = token.split('.');
  expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toMatchObject({ alg: 'ES256', kid: auth.keyId });
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  expect(payload.exp - payload.iat).toBe(900);
  expect(verify('SHA256', Buffer.from(`${header}.${body}`), { key: auth.privateKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))).toBe(true);
  const fetcher = vi.fn().mockResolvedValueOnce(new Response('{"data":[]}')).mockResolvedValueOnce(new Response('')).mockResolvedValueOnce(new Response('private-key-must-not-leak', { status: 401 }));
  const request = createClient(auth, fetcher);
  expect(await request('GET', '/v1/builds')).toEqual({ data: [] });
  expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: 'error', signal: expect.any(AbortSignal) });
  expect(await request('POST', '/v1/builds', { data: [] })).toBeNull();
  await expect(request('GET', '/v1/builds')).rejects.toThrow('failed (401)');
});
it('requires a unique existing group', async () => {
  const entry = { id: 'g', attributes: { name: 'Beta', isInternalGroup: false } };
  expect(await findBetaGroup(async () => ({ data: [entry] }), '123', 'Beta')).toEqual({ id: 'g', isInternal: false });
  await expect(findBetaGroup(async () => ({ data: [] }), '123', 'Beta')).rejects.toThrow('not found');
  await expect(findBetaGroup(async () => ({ data: [entry, entry] }), '123', 'Beta')).rejects.toThrow('ambiguous');
});
it('waits for exactly this version/build, bounds waiting and stops on processing failure', async () => {
  let time = 0;
  const clock = { now: () => time, pause: async () => { time += 30_000; } };
  const request = vi.fn().mockResolvedValueOnce({ data: [] }).mockResolvedValueOnce(build('PROCESSING')).mockResolvedValueOnce(build());
  expect(await waitForBuild(request, options, clock)).toEqual({ id: 'build-id', reviewState: 'APPROVED', groupIds: ['group-id'] });
  expect(request.mock.calls[0][1]).toContain('2.3.0');
  for (const state of ['FAILED', 'INVALID']) await expect(waitForBuild(async () => build(state), options, clock)).rejects.toThrow(state);
  await expect(waitForBuild(async () => build('VALID', true), options, clock)).rejects.toThrow('within 1 minutes');
  await expect(waitForBuild(async () => ({ data: [...build().data, ...build().data] }), options, clock)).rejects.toThrow('Multiple');
  const minimal = { data: [{ id: 'b', attributes: { version: '42', processingState: 'VALID' } }] };
  expect(await waitForBuild(async () => minimal, options, clock)).toEqual({ id: 'b', reviewState: null, groupIds: [] });
});

it('validates submit identity before signing requests', async () => {
  const { readSubmitConfig } = await import('./testflight-distribute.mjs');
  expect(() => readSubmitConfig({})).toThrow('submit.production.ios');
  expect(readSubmitConfig({ submit: { production: { ios: { ascApiKeyId: 'key', ascApiKeyIssuerId: 'issuer', ascAppId: 'app' } } } })).toEqual({ keyId: 'key', issuerId: 'issuer', appId: 'app' });
});
it('distributes idempotently, requests external review only when needed and rejects a refused review', async () => {
  const { distribute } = await import('./testflight-distribute.mjs');
  for (const scenario of ['already-added', 'internal', 'review-needed', 'approved', 'rejected']) {
    const result = build();
    if (scenario !== 'already-added') result.data[0].relationships.betaGroups.data = [];
    if (scenario === 'review-needed' || scenario === 'internal') result.included = [];
    if (scenario === 'rejected') result.included[0].attributes.betaReviewState = 'REJECTED';
    const request = vi.fn().mockResolvedValueOnce({ data: [{ id: 'group-id', attributes: { name: 'Beta', isInternalGroup: scenario === 'internal' } }] }).mockResolvedValueOnce(result).mockResolvedValue(null);
    const operation = distribute(request, '123', { ...options, group: 'Beta' });
    if (scenario === 'rejected') await expect(operation).rejects.toThrow('REJECTED');
    else await operation;
    const posts = request.mock.calls.filter(call => call[0] === 'POST');
    expect(posts).toHaveLength(scenario === 'review-needed' ? 2 : ['internal', 'approved'].includes(scenario) ? 1 : 0);
    if (posts.length) expect(posts.at(-1)[2]).toEqual({ data: [{ type: 'builds', id: 'build-id' }] });
  }
});
it('refreshes API authentication during a long processing wait', async () => {
  vi.useFakeTimers();
  try {
    const fetcher = vi.fn().mockResolvedValue(new Response('{}'));
    const request = createClient(auth, fetcher);
    await request('GET', '/v1/builds');
    vi.advanceTimersByTime(11 * 60_000);
    fetcher.mockResolvedValue(new Response('{}'));
    await request('GET', '/v1/builds');
    expect(fetcher.mock.calls[0][1].headers.authorization).not.toBe(fetcher.mock.calls[1][1].headers.authorization);
  } finally { vi.useRealTimers(); }
});
