import type { AgentRuntimeShellEnvironment } from "./types.js";

interface ThreadShellEnvironmentArgs {
  environmentId: string;
  projectId?: string;
  threadStoragePath?: string;
  threadId: string;
}

interface BuildThreadShellEnvironmentArgs extends ThreadShellEnvironmentArgs {
  baseShellEnv: AgentRuntimeShellEnvironment | undefined;
}

export function buildThreadShellEnvironment(
  args: BuildThreadShellEnvironmentArgs,
): Record<string, string> {
  return {
    ...(args.baseShellEnv ?? {}),
    ...(args.projectId ? { ZCC_PROJECT_ID: args.projectId } : {}),
    ...(args.threadStoragePath
      ? { ZCC_THREAD_STORAGE: args.threadStoragePath }
      : {}),
    ZCC_THREAD_ID: args.threadId,
    ZCC_ENVIRONMENT_ID: args.environmentId,
  };
}
