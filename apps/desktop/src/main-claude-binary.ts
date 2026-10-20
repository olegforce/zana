import type { AppConfig } from '@zana-ai/zcc-domain/product';

/** Same precedence as the server's `configuredClaudeProvider()`: the canonical harness entry, then the legacy flat field. */
export function mainClaudeBinary(config: AppConfig): string {
  return (config.harnesses?.byId?.claude?.binary || config.claudeBinary || 'claude').trim();
}

/** Resolves the binary from the store on every call (`getConfig()` re-reads config.json). */
export function mainClaudeBinaryGetter(store: { getConfig(): AppConfig }): () => string {
  return () => mainClaudeBinary(store.getConfig());
}
