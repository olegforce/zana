import { expect, it, vi } from 'vitest';
import { inspectInvitation, optionsFromArgs, reconcileInvitation, runInvitation, validateOptions } from './testflight-public-link.mjs';

const options = { action: 'publish', appId: '6817069720', groupId: 'cea0a86f-4116-47f1-a394-caea0e7df9a0', buildId: '44c62eba-f183-447b-b901-8b2249afd955', version: '2.3.0', build: '2', limit: 1000 };
const url = 'https://testflight.apple.com/join/Abcd1234';
function apple() {
  const group = { id: options.groupId, attributes: { isInternalGroup: false, publicLinkEnabled: false, publicLinkLimitEnabled: false, publicLinkLimit: 0, publicLink: null as string | null } };
  const build = { data: { id: options.buildId, attributes: { version: '2', processingState: 'VALID', expired: false }, relationships: { app: { data: { id: options.appId } }, preReleaseVersion: { data: { id: 'release' } } } }, included: [
    { type: 'apps', id: options.appId, attributes: { bundleId: 'ai.zana.mobile' } },
    { type: 'preReleaseVersions', id: 'release', attributes: { version: '2.3.0', platform: 'IOS' } },
  ] };
  const detail = { id: options.buildId, attributes: { externalBuildState: 'READY_FOR_BETA_SUBMISSION', autoNotifyEnabled: false } };
  const metadata = { description: 'Native companion', locale: 'en-US', feedbackEmail: 'feedback@example.com', privacyPolicyUrl: 'https://example.com/privacy' };
  const review: Record<string, unknown> = { contactFirstName: 'Test', contactLastName: 'Owner', contactPhone: '+41 000 000 000', contactEmail: 'review@example.com', notes: 'Use the local demo.', demoAccountRequired: false };
  const notes = { locale: 'en-US', whatsNew: 'Pair with the desktop.' };
  let groupAppId = options.appId;
  let attached = false;
  let paginated = false;
  let persistLink = true;
  const request = vi.fn(async (method: string, path: string, body?: any): Promise<any> => {
    if (method === 'GET') {
      if (path === `/v1/betaGroups/${options.groupId}`) return { data: structuredClone(group) };
      if (path.endsWith('/app')) return { data: { id: groupAppId } };
      if (path.includes('?include=')) return structuredClone(build);
      if (path.endsWith('/buildBetaDetail')) return { data: structuredClone(detail) };
      if (path.includes('/betaAppLocalizations')) return { data: [{ attributes: structuredClone(metadata) }], links: { next: paginated ? 'next-page' : null } };
      if (path.endsWith('/betaAppReviewDetail')) return { data: { attributes: structuredClone(review) } };
      if (path.includes('/betaBuildLocalizations')) return { data: [{ attributes: structuredClone(notes) }] };
      if (path.endsWith('/builds?limit=200')) return { data: attached ? [{ id: options.buildId }] : [] };
    }
    if (method === 'POST' && path === '/v1/betaAppReviewSubmissions') detail.attributes.externalBuildState = 'WAITING_FOR_BETA_REVIEW';
    else if (method === 'POST' && path.endsWith('/relationships/builds')) attached = true;
    else if (method === 'PATCH' && path.includes('/buildBetaDetails/')) detail.attributes.autoNotifyEnabled = body.data.attributes.autoNotifyEnabled;
    else if (method === 'PATCH' && path.includes('/betaGroups/')) {
      if (persistLink) Object.assign(group.attributes, body.data.attributes, { publicLink: url });
    } else throw new Error('Unexpected API request');
    return null;
  });
  return { request, group, build, detail, metadata, review, notes,
    attached: () => { attached = true; }, wrongGroupApp: () => { groupAppId = '999999'; }, paginate: () => { paginated = true; }, loseWrite: () => { persistLink = false; },
    mutations: () => request.mock.calls.filter(c => c[0] !== 'GET'),
  };
}

it('validates explicit release identifiers and defaults to a read-only check', () => {
  const argv = ['--group-id', options.groupId, '--build-id', options.buildId, '--version', '2.3.0', '--build', '2'];
  expect(optionsFromArgs(argv, { ASC_APP_ID: options.appId })).toEqual({ ...options, action: 'check' });
  expect(optionsFromArgs([...argv, '--action', 'publish', '--limit', '50'], { ASC_APP_ID: options.appId })).toMatchObject({ action: 'publish', limit: 50 });
  for (const args of [['--unknown', 'x'], ['--action'], ['--action', '--build']]) expect(() => optionsFromArgs(args)).toThrow();
  for (const patch of [{ action: 'delete' }, { appId: '../app' }, { groupId: 'other' }, { buildId: 'latest' }, { version: '1' }, { build: 'latest' }, { limit: 0 }, { limit: 10001 }, { limit: 1.2 }]) expect(() => validateOptions({ ...options, ...patch })).toThrow();
  expect(() => validateOptions({})).toThrow();
});

it('reports missing review metadata without exposing private field values or mutating Apple', async () => {
  const a = apple();
  a.metadata.description = ' ';
  a.metadata.feedbackEmail = 'private invalid email';
  a.metadata.privacyPolicyUrl = 'invalid';
  for (const field of ['contactFirstName', 'contactLastName', 'contactPhone', 'contactEmail', 'notes']) a.review[field] = '';
  a.review.demoAccountRequired = true;
  a.notes.whatsNew = '';
  const result = await reconcileInvitation(a.request, options);
  expect(result.status).toBe('needs-metadata');
  expect(result.missing).toHaveLength(10);
  expect(JSON.stringify(result)).not.toContain('private invalid email');
  expect(a.mutations()).toEqual([]);
});

it('accepts a populated reviewer demo account and rejects non-public privacy URL shapes', async () => {
  const a = apple();
  Object.assign(a.review, { demoAccountRequired: true, demoAccountName: 'private-user', demoAccountPassword: 'private-secret' });
  expect((await inspectInvitation(a.request, options)).missing).toEqual([]);
  for (const policy of ['http://example.com', 'https://user:secret@example.com', 'https://127.0.0.1/privacy', 'https://localhost/privacy']) {
    a.metadata.privacyPolicyUrl = policy;
    expect((await reconcileInvitation(a.request, options)).missing).toContain('Published HTTPS privacy-policy URL');
  }
  a.metadata.locale = 'fr-FR'; a.notes.locale = 'fr-FR';
  expect((await reconcileInvitation(a.request, options)).missing).toContain('What to Test (en-US)');
});

it('fails closed on a mismatched app, group, bundle, build, native version, platform or incomplete response', async () => {
  const changes = [
    (a: ReturnType<typeof apple>) => { a.group.attributes.isInternalGroup = true; },
    (a: ReturnType<typeof apple>) => { a.group.id = 'other'; },
    (a: ReturnType<typeof apple>) => a.wrongGroupApp(),
    (a: ReturnType<typeof apple>) => { a.build.data.id = 'other'; },
    (a: ReturnType<typeof apple>) => { a.build.data.relationships.app.data.id = 'other'; },
    (a: ReturnType<typeof apple>) => { a.build.included[0].attributes.bundleId = 'wrong.bundle'; },
    (a: ReturnType<typeof apple>) => { a.build.included[1].attributes.platform = 'MAC_OS'; },
    (a: ReturnType<typeof apple>) => { a.build.included[1].attributes.version = '0.1.0'; },
    (a: ReturnType<typeof apple>) => { a.build.data.attributes.version = '1'; },
    (a: ReturnType<typeof apple>) => { a.build.data.attributes.processingState = 'PROCESSING'; },
    (a: ReturnType<typeof apple>) => { a.build.data.attributes.expired = true; },
    (a: ReturnType<typeof apple>) => { a.build.included = []; },
    (a: ReturnType<typeof apple>) => a.paginate(),
  ];
  for (const change of changes) {
    const a = apple(); change(a);
    await expect(reconcileInvitation(a.request, options)).rejects.toThrow();
    expect(a.mutations()).toEqual([]);
  }
});

it('submits the exact build once, enables notifications and attaches the external group without enabling its public link', async () => {
  const a = apple();
  expect((await reconcileInvitation(a.request, { ...options, action: 'check' })).status).toBe('ready-to-submit');
  expect(a.mutations()).toHaveLength(0);
  expect((await reconcileInvitation(a.request, options)).status).toBe('waiting-for-apple');
  expect(a.mutations().map(x => x[1])).toEqual([`/v1/buildBetaDetails/${options.buildId}`, '/v1/betaAppReviewSubmissions', `/v1/betaGroups/${options.groupId}/relationships/builds`]);
  expect(a.mutations()[1][2].data.relationships.build.data.id).toBe(options.buildId);
  a.request.mockClear();
  expect((await reconcileInvitation(a.request, options)).status).toBe('waiting-for-apple');
  expect(a.mutations()).toHaveLength(0);
  expect(a.group.attributes.publicLinkEnabled).toBe(false);
});

it.each(['WAITING_FOR_BETA_REVIEW', 'IN_BETA_REVIEW', 'BETA_REJECTED', 'EXPIRED', 'MISSING_EXPORT_COMPLIANCE', 'FUTURE_UNKNOWN_STATE'])('does not enable invitations in Apple state %s', async state => {
  const a = apple(); a.detail.attributes.externalBuildState = state; a.attached(); a.detail.attributes.autoNotifyEnabled = true;
  const result = await reconcileInvitation(a.request, options);
  expect(result.status).toBe(['WAITING_FOR_BETA_REVIEW', 'IN_BETA_REVIEW'].includes(state) ? 'waiting-for-apple' : 'blocked-by-apple');
  expect(a.mutations()).toEqual([]);
  expect(result.publicLink).toBeNull();
});

it.each(['READY_FOR_BETA_TESTING', 'IN_BETA_TESTING', 'BETA_APPROVED'])('publishes only an available approved build, re-reads verification and is idempotent in %s', async state => {
  const a = apple(); a.detail.attributes.externalBuildState = state;
  expect((await reconcileInvitation(a.request, { ...options, action: 'check' })).status).toBe('ready-to-enable');
  expect(a.mutations()).toEqual([]);
  const result = await reconcileInvitation(a.request, options);
  expect(result).toMatchObject({ status: 'available', publicLink: url, limit: 1000 });
  expect(a.mutations().at(-1)?.[2].data.attributes).toEqual({ publicLinkEnabled: true, publicLinkLimitEnabled: true, publicLinkLimit: 1000 });
  a.request.mockClear();
  expect(await reconcileInvitation(a.request, options)).toEqual(result);
  expect(a.mutations()).toEqual([]);
  expect(a.request.mock.calls.filter(x => x[1].includes('/betaTester'))).toEqual([]);
});

it('does not report availability if Apple has not persisted the public link or returned an Apple join URL', async () => {
  const a = apple(); a.detail.attributes.externalBuildState = 'IN_BETA_TESTING'; a.loseWrite();
  await expect(reconcileInvitation(a.request, options)).rejects.toThrow('not confirmed');
  Object.assign(a.group.attributes, { publicLinkEnabled: true, publicLinkLimitEnabled: true, publicLinkLimit: 1000, publicLink: 'https://attacker.example/join/Abcd1234' });
  expect((await reconcileInvitation(a.request, { ...options, action: 'check' })).publicLink).toBeNull();
});

it('enables new-build notifications even when the group invitation is already configured', async () => {
  const a = apple(); a.detail.attributes.externalBuildState = 'IN_BETA_TESTING'; a.attached();
  Object.assign(a.group.attributes, { publicLinkEnabled: true, publicLinkLimitEnabled: true, publicLinkLimit: 1000, publicLink: url });
  expect((await reconcileInvitation(a.request, options)).status).toBe('available');
  expect(a.detail.attributes.autoNotifyEnabled).toBe(true);
});

it('stops on review submission errors without attaching or enabling an invitation', async () => {
  const a = apple();
  const request = vi.fn(async (method: string, path: string, body?: any) => {
    if (path === '/v1/betaAppReviewSubmissions') throw new Error('Apple review request failed');
    return a.request(method, path, body);
  });
  await expect(reconcileInvitation(request, options)).rejects.toThrow('Apple review request failed');
  expect(a.mutations().some(x => x[1].includes('/betaGroups/'))).toBe(false);
});

it('validates CLI credentials before reading a key and runs a read-only check with the configured client', async () => {
  const a = apple();
  const argv = ['--group-id', options.groupId, '--build-id', options.buildId, '--version', '2.3.0', '--build', '2'];
  const env = { ASC_APP_ID: options.appId, ASC_API_KEY_ID: '4PZ3FFF7UQ', ASC_API_KEY_ISSUER_ID: options.groupId, ASC_API_KEY_PATH: '/private/key.p8' };
  const readKey = vi.fn(() => 'private-key'); const client = vi.fn(() => a.request);
  for (const patch of [{ ASC_API_KEY_ID: '' }, { ASC_API_KEY_ISSUER_ID: '' }, { ASC_API_KEY_PATH: '' }]) {
    await expect(runInvitation(argv, { ...env, ...patch }, { readKey, client })).rejects.toThrow('Configure ASC_API_KEY');
  }
  expect(readKey).not.toHaveBeenCalled();
  expect((await runInvitation(argv, env, { readKey, client })).status).toBe('ready-to-submit');
  expect(readKey).toHaveBeenCalledWith('/private/key.p8', 'utf8');
  expect(client).toHaveBeenCalledWith({ keyId: env.ASC_API_KEY_ID, issuerId: env.ASC_API_KEY_ISSUER_ID, privateKey: 'private-key' });
  expect(a.mutations()).toEqual([]);
});
