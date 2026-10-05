import { settingsPath } from "./setup-navigation.js";
import type { ZccPluginApi } from "@zana-ai/zcc-plugin-sdk/server";
// The shipped standalone declarations omit some runtime SDK helpers. Keep their
// use optional; installed hosts with the older declarations still work.
export type Settings = ReturnType<ZccPluginApi["settings"]["define"]>;
export type ThreadEvent = Parameters<
  Parameters<ZccPluginApi["events"]["on"]>[1]
>[0];
export async function machines(
  zcc: ZccPluginApi,
): Promise<{ id: string; name: string; status?: string }[]> {
  const sdk = zcc.sdk as ZccPluginApi["sdk"] & {
    hosts?: {
      list(): Promise<{ id: string; name: string; status?: string }[]>;
    };
  };
  if (sdk.hosts) return sdk.hosts.list();
  const host = await sdk.system.defaultHost();
  return host ? [{ id: host.id, name: "Default Zana machine" }] : [];
}

export function localThreadLink(threadId: string): string | undefined {
  return localAppLink(`/threads/${encodeURIComponent(threadId)}`);
}

export function localSetupLink(pluginId: string): string | undefined {
  return localAppLink(settingsPath(pluginId, true));
}

function localAppLink(path: string): string | undefined {
  try {
    const base = new URL(process.env.ZCC_SERVER_URL || "http://127.0.0.1:8780");
    if (
      ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) &&
      ["http:", "https:"].includes(base.protocol)
    )
      return `${base.origin}${path}`;
  } catch {
    /* An optional navigation link must never block Slack delivery. */
  }
}
