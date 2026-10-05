import type { ZccPluginApi } from "@zana-ai/zcc-plugin-sdk/server";

export const slackInteractionSurface = { kind: "remote", label: "Slack" } as const;
/** The pinned SDK tarball predates this existing host API. Keep the compatibility
 * type local; never replace a missing host operation with a silent success. */
export async function persistSlackSurface(zcc: ZccPluginApi, threadId: string): Promise<void> {
  const threads = zcc.sdk.threads as typeof zcc.sdk.threads & {
    updatePluginMetadata(args: { threadId: string; set: { interactionSurface: typeof slackInteractionSurface } }): Promise<unknown>;
  };
  if (typeof threads.updatePluginMetadata !== "function") throw new Error("Update Zana to use Slack-controlled conversations.");
  await threads.updatePluginMetadata({ threadId, set: { interactionSurface: slackInteractionSurface } });
}
