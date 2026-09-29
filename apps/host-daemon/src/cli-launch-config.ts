import { CliSharedConfigSchema, type CliSharedConfig } from '@zana-ai/zcc-contracts/cli-terminal';
import { projectConfigCompatibility } from '@zana-ai/zcc-domain/harness-config-compatibility';
import type { AppConfig } from '@zana-ai/zcc-domain/product';

/** Project canonical preferences before crossing the machine boundary. Do not
 * serialize AppConfig: it also contains machine paths and authentication data. */
export function sharedCliConfig(config: AppConfig): CliSharedConfig {
  const compatible = projectConfigCompatibility(config);
  return CliSharedConfigSchema.parse(Object.fromEntries(
    Object.keys(CliSharedConfigSchema.shape).map(key => [key, compatible[key as keyof AppConfig]])
  ));
}

/** Execution uses host-local binaries and resource limits. Logical preferences
 * are replaced as a complete snapshot, including absent/default values. */
export function executionCliConfig(hostConfig: AppConfig, shared: CliSharedConfig): AppConfig {
  const host = projectConfigCompatibility(hostConfig);
  return {
    version: 1, theme: 'dark', fontSize: 13, lastProjectId: null,
    shell: host.shell, claudeBinary: host.claudeBinary,
    cursorBinary: host.cursorBinary, codexBinary: host.codexBinary,
    piBinary: host.piBinary, opencodeBinary: host.opencodeBinary,
    grokBinary: host.grokBinary, mastracodeBinary: host.mastracodeBinary,
    afcodeBinary: host.afcodeBinary,
    maxLiveSessions: host.maxLiveSessions,
    claudeMaxOldSpaceMB: host.claudeMaxOldSpaceMB,
    // The enrolled daemon owns the process lifetime; no detached tmux orphan.
    tmuxScope: 'off',
    ...CliSharedConfigSchema.parse(shared)
  } as AppConfig;
}
