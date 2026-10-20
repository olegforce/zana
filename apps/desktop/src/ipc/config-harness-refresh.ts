import type { AppConfig } from '@zana-ai/zcc-domain/product';

const runtimeKeys = [
  'claudeBinary', 'cursorBinary', 'codexBinary', 'piBinary', 'opencodeBinary',
  'grokBinary', 'mastracodeBinary', 'afcodeBinary',
  'harnessCursorEnabled', 'harnessCodexEnabled', 'harnessPiEnabled',
  'harnessOpenCodeEnabled', 'harnessGrokEnabled', 'harnessMastracodeEnabled', 'harnessAfcodeEnabled'
] as const;

/** Compare committed, normalized settings rather than the caller's patch shape. */
export function reconcileHarnessConfig(
  previous: AppConfig,
  next: AppConfig,
  effects: {
    invalidate(): void;
    /** Unused: the claude-cli provider reads its binary from the store on every run. */
    rebuildProviders?(config: AppConfig): void;
  }
): void {
  if (runtimeKeys.some((key) => previous[key] !== next[key])
    || JSON.stringify(previous.harnesses) !== JSON.stringify(next.harnesses)) {
    effects.invalidate();
  }
}
