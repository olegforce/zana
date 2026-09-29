import { expect, it } from 'vitest';
import type { AppConfig } from '@zana-ai/zcc-domain/product';
import { CliTerminalStartCommandSchema } from '@zana-ai/zcc-contracts/cli-terminal';
import { sharedCliConfig, executionCliConfig } from './cli-launch-config.js';

it('projects canonical shared preferences without machine paths, secrets or unrelated settings', () => {
  const config = { version: 1, shell: '/owner/sh', claudeBinary: '/owner/claude', theme: 'light',
    claudeAppendSystemPrompt: 'obsolete', defaultPermissionMode: 'bypassPermissions',
    harnesses: { byId: { claude: { binary: '/owner/canonical', compatibility: {
      appendSystemPrompt: 'shared', executionPolicy: { target: 'native-default-with-auto', autoMode: { enabled: true, hardDeny: ['never delete'] } }
    } } } }, harnessAuth: { claude: { token: 'must-not-travel' } }, trustZccToolsEnabled: false
  } as AppConfig;
  expect(JSON.parse(JSON.stringify(sharedCliConfig(config)))).toEqual({
    claudeAppendSystemPrompt: 'shared', defaultPermissionMode: 'default',
    autoModeEnabled: true, autoModeHardDeny: ['never delete'], trustZccToolsEnabled: false
  });
  expect(config.claudeAppendSystemPrompt).toBe('obsolete');
});

it('keeps execution-owner binaries and limits while fully replacing logical preferences', () => {
  const host = { version: 1, shell: '/host/sh', claudeBinary: '/legacy/claude', claudeMaxOldSpaceMB: 200,
    maxLiveSessions: 7, tmuxScope: 'all', defaultModel: 'host-model', autoModeEnabled: false,
    claudeExtraArgs: ['--host-only'], harnessRouting: { schemaVersion: 1, byAdapter: { claude: { roleTargetId: 'host-role' } } },
    harnesses: { byId: { claude: { binary: '/host/claude', compatibility: { model: 'canonical-host-model' } }, afcode: { binary: '/host/afcode' } } }
  } as AppConfig;
  const result = executionCliConfig(host, { defaultModel: 'shared-model', trustZccToolsEnabled: true });
  expect(result).toMatchObject({ claudeBinary: '/host/claude', afcodeBinary: '/host/afcode', shell: '/host/sh', defaultModel: 'shared-model', tmuxScope: 'off', maxLiveSessions: 7, claudeMaxOldSpaceMB: 200 });
  for (const key of ['harnesses', 'harnessRouting', 'autoModeEnabled', 'claudeExtraArgs']) expect(result[key as keyof AppConfig]).toBeUndefined();
  expect(() => executionCliConfig(host, { claudeBinary: '/remote/injected' } as never)).toThrow();
  expect(host.tmuxScope).toBe('all');
});

it('closes the wire launch shape, excludes unsupported environments and bounds the aggregate payload', () => {
  const command = { type: 'terminal.start_cli', grant: { projectId: 'project', sessionId: '11111111-1111-4111-8111-111111111111', credential: 'a'.repeat(64) }, root: '/project', profile: 'claude', cols: 80, rows: 24, config: {} };
  expect(CliTerminalStartCommandSchema.parse(command)).toEqual(command);
  for (const patch of [
    { env: { TOKEN: 'secret' } }, { profile: 'shell' }, { callbackUrl: 'https://outside' },
    { config: { shell: 'injected' } }, { config: { harnesses: { byId: { claude: { binary: 'injected' } } } } },
    { environment: 'microvm' }, { projectSettings: { remoteToolProxy: true } },
    { persona: { id: 'x', name: 'x', source: { extensionId: 'x' } } },
    { rules: 'r'.repeat(256 * 1024) }, { extraArgs: ['x'.repeat(32_769)] }
  ]) expect(CliTerminalStartCommandSchema.safeParse({ ...command, ...patch }).success).toBe(false);
});
