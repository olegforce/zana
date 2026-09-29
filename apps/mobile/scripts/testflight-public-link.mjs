#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createClient } from './testflight-distribute.mjs';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const invitation = /^https:\/\/testflight\.apple\.com\/join\/[A-Za-z0-9]{8}$/;
const availableStates = new Set(['READY_FOR_BETA_TESTING', 'IN_BETA_TESTING', 'BETA_APPROVED']);
const pendingStates = new Set(['WAITING_FOR_BETA_REVIEW', 'IN_BETA_REVIEW']);

export function validateOptions(options) {
  if (!['check', 'publish'].includes(options.action) || !/^\d{6,20}$/.test(options.appId ?? '') ||
      !uuid.test(options.groupId ?? '') || !uuid.test(options.buildId ?? '') ||
      !/^\d+\.\d+\.\d+$/.test(options.version ?? '') || !/^\d+(\.\d+){0,2}$/.test(options.build ?? '') ||
      !Number.isInteger(options.limit) || options.limit < 1 || options.limit > 10_000) {
    throw new Error('Specify check/publish, app/group/build IDs, exact version/build, and a tester limit from 1 to 10000.');
  }
  return options;
}

export function optionsFromArgs(argv, env = process.env) {
  const options = { action: 'check', appId: env.ASC_APP_ID, limit: 1000 };
  const flags = { '--action': 'action', '--group-id': 'groupId', '--build-id': 'buildId', '--version': 'version', '--build': 'build', '--limit': 'limit' };
  for (let i = 0; i < argv.length; i += 2) {
    const field = flags[argv[i]];
    if (!field || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('Unknown flag or missing argument.');
    options[field] = field === 'limit' ? Number(argv[i + 1]) : argv[i + 1];
  }
  return validateOptions(options);
}

function list(result) {
  // Never decide eligibility from an incomplete first page.
  if (result.links?.next || !Array.isArray(result.data)) throw new Error('Incomplete Apple response; no invitation changes made.');
  return result.data;
}

function present(value) { return typeof value === 'string' && value.trim().length > 0; }
function email(value) { return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }
function publicHttps(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && url.hostname.includes('.') &&
      !/^(?:localhost|127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(url.hostname);
  } catch { return false; }
}

export async function inspectInvitation(request, options) {
  validateOptions(options);
  const { appId, groupId, buildId } = options;
  const [groupResult, groupApp, buildResult, betaDetail, localizations, review, notes, groupBuilds] = await Promise.all([
    request('GET', `/v1/betaGroups/${groupId}`),
    request('GET', `/v1/betaGroups/${groupId}/app`),
    request('GET', `/v1/builds/${buildId}?include=app,preReleaseVersion`),
    request('GET', `/v1/builds/${buildId}/buildBetaDetail`),
    request('GET', `/v1/apps/${appId}/betaAppLocalizations?limit=200`),
    request('GET', `/v1/apps/${appId}/betaAppReviewDetail`),
    request('GET', `/v1/builds/${buildId}/betaBuildLocalizations?limit=200`),
    request('GET', `/v1/betaGroups/${groupId}/builds?limit=200`),
  ]);
  const group = groupResult.data;
  const build = buildResult.data;
  const included = buildResult.included ?? [];
  const app = included.find(x => x.type === 'apps' && x.id === appId);
  const release = included.find(x => x.type === 'preReleaseVersions' && x.id === build.relationships?.preReleaseVersion?.data?.id);
  if (group.id !== groupId || group.attributes.isInternalGroup !== false || groupApp.data.id !== appId ||
      build.id !== buildId || build.relationships?.app?.data?.id !== appId || app?.attributes.bundleId !== 'ai.zana.mobile' ||
      release?.attributes.platform !== 'IOS' || release.attributes.version !== options.version ||
      build.attributes.version !== options.build || build.attributes.processingState !== 'VALID' || build.attributes.expired !== false) {
    throw new Error('Apple app, external group or unexpired iOS build does not match the requested Zana release.');
  }
  const betaInfo = list(localizations).find(x => x.attributes.locale === 'en-US')?.attributes ?? {};
  const reviewInfo = review.data?.attributes ?? {};
  const buildNotes = list(notes).find(x => x.attributes.locale === 'en-US')?.attributes;
  const missing = [];
  if (!present(betaInfo.description)) missing.push('Beta description (en-US)');
  if (!email(betaInfo.feedbackEmail)) missing.push('Feedback email');
  if (!publicHttps(betaInfo.privacyPolicyUrl)) missing.push('Published HTTPS privacy-policy URL');
  for (const [field, label] of [['contactFirstName', 'Review contact first name'], ['contactLastName', 'Review contact last name'], ['contactPhone', 'Review contact phone'], ['notes', 'Review notes']]) {
    if (!present(reviewInfo[field])) missing.push(label);
  }
  if (!email(reviewInfo.contactEmail)) missing.push('Review contact email');
  if (reviewInfo.demoAccountRequired === true && (!present(reviewInfo.demoAccountName) || !present(reviewInfo.demoAccountPassword))) missing.push('Required reviewer demo account');
  if (!present(buildNotes?.whatsNew)) missing.push('What to Test (en-US)');
  return { group, betaDetail: betaDetail.data, missing, attached: list(groupBuilds).some(x => x.id === buildId) };
}

export async function reconcileInvitation(request, options) {
  const state = await inspectInvitation(request, options);
  const externalState = state.betaDetail.attributes.externalBuildState;
  const result = { appId: options.appId, groupId: options.groupId, buildId: options.buildId,
    version: options.version, build: options.build, externalState, missing: state.missing, publicLink: null };
  if (state.missing.length) return { ...result, status: 'needs-metadata' };
  if (!availableStates.has(externalState) && !pendingStates.has(externalState) && externalState !== 'READY_FOR_BETA_SUBMISSION') {
    return { ...result, status: 'blocked-by-apple' };
  }
  const attrs = state.group.attributes;
  if (availableStates.has(externalState) && state.attached && state.betaDetail.attributes.autoNotifyEnabled === true && attrs.publicLinkEnabled === true &&
      attrs.publicLinkLimitEnabled === true && attrs.publicLinkLimit === options.limit && invitation.test(attrs.publicLink ?? '')) {
    return { ...result, status: 'available', publicLink: attrs.publicLink, limit: options.limit };
  }
  if (options.action === 'check') return { ...result, status: availableStates.has(externalState) ? 'ready-to-enable' : pendingStates.has(externalState) ? 'waiting-for-apple' : 'ready-to-submit' };

  if (state.betaDetail.attributes.autoNotifyEnabled !== true) {
    await request('PATCH', `/v1/buildBetaDetails/${state.betaDetail.id}`, {
      data: { type: 'buildBetaDetails', id: state.betaDetail.id, attributes: { autoNotifyEnabled: true } },
    });
  }
  if (externalState === 'READY_FOR_BETA_SUBMISSION') {
    await request('POST', '/v1/betaAppReviewSubmissions', {
      data: { type: 'betaAppReviewSubmissions', relationships: { build: { data: { type: 'builds', id: options.buildId } } } },
    });
  }
  if (!state.attached) {
    await request('POST', `/v1/betaGroups/${options.groupId}/relationships/builds`, { data: [{ type: 'builds', id: options.buildId }] });
  }
  if (!availableStates.has(externalState)) return { ...result, status: 'waiting-for-apple' };

  // This operation affects TestFlight enrollment only, never desktop access.
  await request('PATCH', `/v1/betaGroups/${options.groupId}`, {
    data: { type: 'betaGroups', id: options.groupId, attributes: { publicLinkEnabled: true, publicLinkLimitEnabled: true, publicLinkLimit: options.limit } },
  });
  // Report availability only from a fresh read, including the exact build's eligibility.
  const verified = await reconcileInvitation(request, { ...options, action: 'check' });
  if (verified.status !== 'available') throw new Error('Apple has not confirmed the enabled invitation. Re-run check before sharing it.');
  return verified;
}

export async function runInvitation(argv, env = process.env, { readKey = readFileSync, client = createClient } = {}) {
  const options = optionsFromArgs(argv, env);
  if (!/^[A-Z0-9]{10}$/.test(env.ASC_API_KEY_ID ?? '') || !uuid.test(env.ASC_API_KEY_ISSUER_ID ?? '') || !env.ASC_API_KEY_PATH) {
    throw new Error('Configure ASC_API_KEY_ID, ASC_API_KEY_ISSUER_ID and ASC_API_KEY_PATH in the release environment.');
  }
  const request = client({ keyId: env.ASC_API_KEY_ID, issuerId: env.ASC_API_KEY_ISSUER_ID, privateKey: readKey(env.ASC_API_KEY_PATH, 'utf8') });
  return reconcileInvitation(request, options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runInvitation(process.argv.slice(2)).then(result => {
    console.log(JSON.stringify(result, null, 2));
    if (['needs-metadata', 'blocked-by-apple'].includes(result.status)) process.exitCode = 2;
  }).catch(() => {
    console.error('TestFlight invitation operation failed. Check arguments, release credentials and Apple state; no credential or contact values are logged.');
    process.exitCode = 1;
  });
}
