import { expect, it } from 'vitest';
import { EAS_CLI_VERSION, finishedBuild, prepare, releaseConfig, runReleaseCommand } from './release-config.mjs';
const id = '12345678-1234-1234-1234-123456789abc';
const env = { MOBILE_RELEASE_ENABLED: 'true', EXPO_PUBLIC_EAS_PROJECT_ID: id, EXPO_OWNER: 'zana-release', APPLE_TEAM_ID: 'TEAM123456', ASC_APP_ID: '1234567890', ASC_API_KEY_ID: 'KEY1234567', ASC_API_KEY_ISSUER_ID: id, ASC_API_KEY_PATH: '/tmp/private.p8', EXPO_TOKEN: 'secret' };
const record = { id, app: { id }, appIdentifier: 'ai.zana.mobile', isForIosSimulator: false, buildProfile: 'production', status: 'FINISHED', platform: 'IOS', distribution: 'STORE', appVersion: '2.3.0', appBuildVersion: '42', artifacts: { buildUrl: 'https://expo.dev/artifacts/eas/abc.ipa' } };
it('fails closed without Zana identities and explicit release activation', () => {
  expect(() => releaseConfig({})).toThrow('EXPO_PUBLIC');
  for (const key of Object.keys(env).filter(key => key !== 'ASC_API_KEY_PATH'))
    expect(() => releaseConfig({ ...env, [key]: '' })).toThrow();
  expect(releaseConfig(env).ios.ascAppId).toBe(env.ASC_APP_ID);
});
it('prepares a store-only profile preserving unrelated profiles without embedding tokens', () => {
  const result = prepare({ build: { development: { simulator: true }, production: { autoIncrement: true } } }, releaseConfig(env));
  expect(result.build.development).toEqual({ simulator: true });
  expect(result.build.production).toMatchObject({ distribution: 'store', developmentClient: false, autoIncrement: true, ios: { simulator: false } });
  expect(result.cli.version).toBe(EAS_CLI_VERSION);
  expect(JSON.stringify(result)).not.toContain('secret');
});
it('accepts only the single completed build from the expected project and version', () => {
  expect(finishedBuild([record], '2.3.0', id)).toMatchObject({ id, version: '2.3.0', build: '42' });
  expect(finishedBuild(record, '2.3.0', id).url).toContain('expo.dev');
  for (const patch of [{ id: 'wrong' }, { platform: 'ANDROID' }, { distribution: 'INTERNAL' }, { status: 'ERRORED' }, { appVersion: '0.1.0' }, { app: { id: 'different' } }, { appIdentifier: 'wrong.app' }, { isForIosSimulator: true }, { buildProfile: 'preview' }, { appBuildVersion: '42\nmalicious=value' }, { artifacts: { buildUrl: 'https://evil.example/ipa' } }, { artifacts: { buildUrl: 'https://expo.dev/artifacts/eas/x?token=x' } }, { artifacts: {} }])
    expect(() => finishedBuild({ ...record, ...patch }, '2.3.0', id)).toThrow();
  expect(() => finishedBuild([], '2.3.0', id)).toThrow();
  expect(() => finishedBuild([record, record], '2.3.0', id)).toThrow();
});

it('runs preflight and result extraction in a disposable checkout, and refuses unknown actions', async () => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { execFileSync } = await import('node:child_process');
  const cwd = mkdtempSync(join(tmpdir(), 'zana-release-config-test-'));
  const script = fileURLToPath(new URL('./release-config.mjs', import.meta.url));
  const run = (action: string) => execFileSync(process.execPath, [script, action], { cwd, env: { ...process.env, ...env, GITHUB_OUTPUT: join(cwd, 'output') }, stdio: 'pipe' });
  try {
    writeFileSync(join(cwd, 'eas.json'), JSON.stringify({ build: { production: { autoIncrement: true } } }));
    writeFileSync(join(cwd, 'app.json'), JSON.stringify({ expo: { version: '2.3.0' } }));
    writeFileSync(join(cwd, 'eas-build.json'), JSON.stringify([record]));
    runReleaseCommand('prepare', env, cwd);
    run('prepare');
    expect(JSON.parse(readFileSync(join(cwd, 'eas.json'), 'utf8')).submit.production.ios.ascAppId).toBe(env.ASC_APP_ID);
    runReleaseCommand('result', { ...env, GITHUB_OUTPUT: join(cwd, 'output') }, cwd);
    run('result');
    expect(() => runReleaseCommand('unknown', env, cwd)).toThrow();
    expect(readFileSync(join(cwd, 'output'), 'utf8')).toContain('build=42\n');
    expect(() => run('unknown')).toThrow();
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
