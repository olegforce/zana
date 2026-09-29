import type { AppConfig } from './product.js';

const HARNESS_FAMILIES = ['claude', 'cursor', 'codex', 'pi', 'opencode', 'grok', 'mastracode', 'afcode'] as const;

/** Shared read projection for desktop and daemon. Canonical persisted fields
 * win over legacy fields; the supplied config and its nested records are not mutated. */
export function projectConfigCompatibility(config: AppConfig): AppConfig {
  const next = { ...config };
  const byId = config.harnesses?.byId;
  const binaries = { claude: 'claudeBinary', cursor: 'cursorBinary', codex: 'codexBinary', pi: 'piBinary', opencode: 'opencodeBinary', grok: 'grokBinary', mastracode: 'mastracodeBinary', afcode: 'afcodeBinary' } as const;
  const enabled = { cursor: 'harnessCursorEnabled', codex: 'harnessCodexEnabled', pi: 'harnessPiEnabled', opencode: 'harnessOpenCodeEnabled', grok: 'harnessGrokEnabled', mastracode: 'harnessMastracodeEnabled', afcode: 'harnessAfcodeEnabled' } as const;
  for (const id of HARNESS_FAMILIES) {
    const entry = byId?.[id];
    if (entry?.binary !== undefined) (next as Record<string, unknown>)[binaries[id]] = entry.binary;
    if (id !== 'claude' && entry?.enabled !== undefined) (next as Record<string, unknown>)[enabled[id]] = entry.enabled;
  }
  const claude = byId?.claude?.compatibility;
  const codex = byId?.codex?.compatibility;
  const pi = byId?.pi?.compatibility;
  if (claude?.model !== undefined) next.defaultModel = claude.model as AppConfig['defaultModel'];
  if (claude?.executionPolicy?.target === 'native-default-with-auto') next.defaultPermissionMode = 'default';
  else if (claude?.permissionMode !== undefined) next.defaultPermissionMode = claude.permissionMode as AppConfig['defaultPermissionMode'];
  for (const [destination, source] of [['claudeAppendSystemPrompt', 'appendSystemPrompt'], ['claudeExtraArgs', 'extraArgs'], ['claudeAddDirs', 'addDirs'], ['claudeAllowedTools', 'allowedTools'], ['claudeDeniedTools', 'deniedTools']] as const) if (claude?.[source] !== undefined) (next as Record<string, unknown>)[destination] = claude[source];
  if (codex?.codexSandbox !== undefined) next.defaultCodexSandbox = codex.codexSandbox as AppConfig['defaultCodexSandbox'];
  if (codex?.codexApproval !== undefined) next.defaultCodexApproval = codex.codexApproval as AppConfig['defaultCodexApproval'];
  if (pi?.provider !== undefined) next.piProvider = pi.provider;
  if (pi?.model !== undefined) next.piModel = pi.model;
  if (pi?.thinking !== undefined) next.piThinking = pi.thinking as AppConfig['piThinking'];
  const auto = claude?.executionPolicy?.target === 'native-default-with-auto'
    ? claude.executionPolicy.autoMode
    : claude?.autoMode;
  if (auto?.enabled !== undefined) next.autoModeEnabled = auto.enabled;
  if (auto?.environment !== undefined) next.autoModeEnvironment = auto.environment;
  if (auto?.allow !== undefined) next.autoModeAllow = auto.allow;
  if (auto?.softDeny !== undefined) next.autoModeSoftDeny = auto.softDeny;
  if (auto?.hardDeny !== undefined) next.autoModeHardDeny = auto.hardDeny;
  if (auto?.classifyAllShell !== undefined) next.autoModeClassifyAllShell = auto.classifyAllShell;
  return next;
}
