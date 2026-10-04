import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const PI_BRIDGE_SESSION_DIR_ENV = "ZCC_PI_BRIDGE_SESSION_DIR";

export interface ResolvePiBridgeSessionDirArgs {
  env: NodeJS.ProcessEnv;
}

export interface ResolvePiSessionFilePathArgs
  extends ResolvePiBridgeSessionDirArgs {
  threadId: string;
}

export function resolvePiBridgeSessionDir(
  args: ResolvePiBridgeSessionDirArgs,
): string {
  const configuredSessionDir = (args.env[PI_BRIDGE_SESSION_DIR_ENV] ?? args.env.BB_PI_BRIDGE_SESSION_DIR)?.trim();
  if (configuredSessionDir) {
    return resolve(configuredSessionDir);
  }

  return join(homedir(), ".zcc", "pi-bridge-sessions");
}

export function resolvePiSessionFilePath(
  args: ResolvePiSessionFilePathArgs,
): string {
  const key = `${sanitizeSessionKey(args.threadId)}.jsonl`;
  const canonical = join(resolvePiBridgeSessionDir({ env: args.env }), key);
  // Resume existing files in place; new sessions use the canonical data directory.
  if ((args.env[PI_BRIDGE_SESSION_DIR_ENV] ?? args.env.BB_PI_BRIDGE_SESSION_DIR)?.trim() || existsSync(canonical)) {
    return canonical;
  }
  const legacy = join(homedir(), ".bb", "pi-bridge-sessions", key);
  return existsSync(legacy) ? legacy : canonical;
}

function sanitizeSessionKey(threadId: string): string {
  return threadId.replace(/[^A-Za-z0-9._-]/g, "_");
}
