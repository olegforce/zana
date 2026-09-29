import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

export const EAS_CLI_VERSION = '24.8.0';
const uuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export function releaseConfig(env) {
  const rules = {
    EXPO_PUBLIC_EAS_PROJECT_ID: uuid, EXPO_OWNER: /^[a-zA-Z0-9_-]{1,80}$/,
    APPLE_TEAM_ID: /^[A-Z0-9]{10}$/, ASC_APP_ID: /^[0-9]{6,20}$/,
    ASC_API_KEY_ID: /^[A-Z0-9]{10}$/, ASC_API_KEY_ISSUER_ID: uuid
  };
  for (const [name, rule] of Object.entries(rules)) {
    if (!rule.test(env[name] ?? '')) throw new Error(`Configure ${name} for Zana in the mobile-ios-release environment.`);
  }
  if (env.MOBILE_RELEASE_ENABLED !== 'true') throw new Error('Mobile release is disabled. Configure and approve the release environment first.');
  if (!env.EXPO_TOKEN) throw new Error('EXPO_TOKEN is required. Store it as an environment secret.');
  return {
    projectId: env.EXPO_PUBLIC_EAS_PROJECT_ID, owner: env.EXPO_OWNER, teamId: env.APPLE_TEAM_ID,
    ios: { ascAppId: env.ASC_APP_ID, appleTeamId: env.APPLE_TEAM_ID,
      ascApiKeyId: env.ASC_API_KEY_ID, ascApiKeyIssuerId: env.ASC_API_KEY_ISSUER_ID,
      ascApiKeyPath: env.ASC_API_KEY_PATH }
  };
}

export function finishedBuild(result, version, projectId) {
  const builds = Array.isArray(result) ? result : [result];
  if (builds.length !== 1) throw new Error('Expected exactly one iOS build.');
  const build = builds[0];
  if (!build || !uuid.test(build.id) || build.status !== 'FINISHED' || build.platform !== 'IOS' ||
    build.distribution !== 'STORE' || build.app?.id !== projectId || build.appIdentifier !== 'ai.zana.mobile' || build.isForIosSimulator !== false || build.buildProfile !== 'production' || build.appVersion !== version ||
    typeof build.appBuildVersion !== 'string' || !/^\d+(\.\d+){0,2}$/.test(build.appBuildVersion)) {
    throw new Error('EAS result does not match the requested Zana store build.');
  }
  const url = new URL(build.artifacts?.buildUrl ?? '');
  if (url.protocol !== 'https:' || url.hostname !== 'expo.dev' || !url.pathname.startsWith('/artifacts/eas/') || url.username || url.password || url.hash || url.search) {
    throw new Error('Unexpected EAS artifact URL.');
  }
  return { id: build.id, version, build: build.appBuildVersion, url: url.href };
}

export function prepare(eas, config) {
  return { ...eas, cli: { ...eas.cli, version: EAS_CLI_VERSION, appVersionSource: 'remote' },
    build: { ...eas.build, production: { ...eas.build.production, distribution: 'store', developmentClient: false,
      ios: { ...eas.build.production.ios, simulator: false },
      env: { ...eas.build.production.env, EXPO_PUBLIC_EAS_PROJECT_ID: config.projectId, EXPO_OWNER: config.owner } } },
    submit: { ...eas.submit, production: { ios: config.ios } }
  };
}

export function runReleaseCommand(action, env = process.env, directory = process.cwd()) {
  const config = releaseConfig(env);
  if (action === 'prepare') {
    // Only run in the workflow's disposable checkout. Never rewrite a developer's native tree.
    const file = join(directory, 'eas.json');
    const eas = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, `${JSON.stringify(prepare(eas, config), null, 2)}\n`);
  } else if (action === 'result') {
    const app = JSON.parse(readFileSync(join(directory, 'app.json'), 'utf8')).expo;
    const build = finishedBuild(JSON.parse(readFileSync(join(directory, 'eas-build.json'), 'utf8')), app.version, config.projectId);
    appendFileSync(env.GITHUB_OUTPUT, `id=${build.id}\nversion=${build.version}\nbuild=${build.build}\nurl=${build.url}\n`);
  } else throw new Error('Expected prepare or result.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { runReleaseCommand(process.argv[2]); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
