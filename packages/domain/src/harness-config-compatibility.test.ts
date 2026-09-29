import { expect, it } from 'vitest';
import type { AppConfig } from './product.js';
import { projectConfigCompatibility } from './harness-config-compatibility.js';

it('preserves legacy-only settings and never mutates its input', () => {
  const input = { claudeBinary: '/legacy', opencodeBinary: '/old', autoModeEnabled: true } as AppConfig;
  expect(projectConfigCompatibility(input)).toEqual(input);
  expect(projectConfigCompatibility(input)).not.toBe(input);
  expect(projectConfigCompatibility({ ...input, harnesses: { byId: {} } })).toEqual({ ...input, harnesses: { byId: {} } });
});
it('projects every canonical binary and enabled setting over stale legacy values', () => {
  const byId = Object.fromEntries(['claude', 'cursor', 'codex', 'pi', 'opencode', 'grok', 'mastracode', 'afcode'].map(id => [id, { binary: `/machine/${id}`, enabled: false }]));
  const input = { claudeBinary: '/old', harnessOpenCodeEnabled: true, harnesses: { byId } } as AppConfig;
  const before = JSON.stringify(input);
  expect(projectConfigCompatibility(input)).toMatchObject({
    claudeBinary: '/machine/claude', cursorBinary: '/machine/cursor', codexBinary: '/machine/codex', piBinary: '/machine/pi',
    opencodeBinary: '/machine/opencode', grokBinary: '/machine/grok', mastracodeBinary: '/machine/mastracode', afcodeBinary: '/machine/afcode',
    harnessCursorEnabled: false, harnessCodexEnabled: false, harnessPiEnabled: false, harnessOpenCodeEnabled: false,
    harnessGrokEnabled: false, harnessMastracodeEnabled: false, harnessAfcodeEnabled: false
  });
  expect(JSON.stringify(input)).toBe(before);
});
it('projects legacy compatibility and native auto-policy forms without widening permission mode', () => {
  const autoMode = { enabled: false, environment: 'test', allow: ['a'], softDeny: ['b'], hardDeny: ['c'], classifyAllShell: false };
  const input = { harnesses: { byId: {
    claude: { compatibility: { model: 'm', permissionMode: 'plan', appendSystemPrompt: 'p', extraArgs: ['x'], addDirs: ['/a'], allowedTools: ['read'], deniedTools: ['write'], autoMode } },
    codex: { compatibility: { codexSandbox: 'read-only', codexApproval: 'on-request' } },
    pi: { compatibility: { provider: 'provider', model: 'pi-model', thinking: 'high' } }
  } } } as unknown as AppConfig;
  expect(projectConfigCompatibility(input)).toMatchObject({
    defaultModel: 'm', defaultPermissionMode: 'plan', claudeAppendSystemPrompt: 'p', claudeExtraArgs: ['x'], claudeAddDirs: ['/a'], claudeAllowedTools: ['read'], claudeDeniedTools: ['write'],
    defaultCodexSandbox: 'read-only', defaultCodexApproval: 'on-request', piProvider: 'provider', piModel: 'pi-model', piThinking: 'high',
    autoModeEnabled: false, autoModeEnvironment: 'test', autoModeAllow: ['a'], autoModeSoftDeny: ['b'], autoModeHardDeny: ['c'], autoModeClassifyAllShell: false
  });
  const native = { ...input, harnesses: { byId: { claude: { compatibility: {
    permissionMode: 'bypassPermissions', executionPolicy: { target: 'native-default-with-auto', autoMode: { enabled: true } }
  } } } } } as AppConfig;
  expect(projectConfigCompatibility(native)).toMatchObject({ defaultPermissionMode: 'default', autoModeEnabled: true });
});
