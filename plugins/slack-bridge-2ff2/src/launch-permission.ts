import type { ZccPluginApi } from "@zana-ai/zcc-plugin-sdk/server";

type ProviderInfo = Awaited<
  ReturnType<ZccPluginApi["sdk"]["providers"]["list"]>
>[number];
type PermissionMode = Parameters<
  ZccPluginApi["sdk"]["threads"]["spawn"]
>[0]["permissionMode"];

/** Prefer the existing Slack mode, then the provider's next supported mode. */
export function launchPermission(
  provider: ProviderInfo | undefined,
): PermissionMode {
  if (!provider?.available) return undefined;
  // Older SDKs omitted capabilities; retain their existing launch contract.
  const modes = provider.capabilities?.permissionModes ?? ["accept-edits"];
  return (["accept-edits", "auto", "full"] as const).find((mode) =>
    modes.includes(mode),
  );
}
