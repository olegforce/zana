import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAppServerLaunch } from "./bridge.js";

afterEach(() => vi.unstubAllEnvs());

describe("Codex Account Pool launch", () => {
  it("reads legacy executable overrides but prioritizes ZCC configuration", () => {
    const legacy = { BB_CODEX_BRIDGE_APP_SERVER_COMMAND: "/old/codex", BB_CODEX_BRIDGE_APP_SERVER_ARGS: '["old"]' };
    expect(resolveAppServerLaunch(legacy)).toEqual({ command: "/old/codex", args: ["old"] });
    expect(resolveAppServerLaunch({ ...legacy, ZCC_CODEX_BRIDGE_APP_SERVER_COMMAND: "/new/codex", ZCC_CODEX_BRIDGE_APP_SERVER_ARGS: '["new"]' })).toEqual({ command: "/new/codex", args: ["new"] });
    expect(() => resolveAppServerLaunch({ ...legacy, ZCC_CODEX_BRIDGE_APP_SERVER_ARGS: "invalid" })).toThrow();
  });
  it("adds an in-memory base URL and environment-backed hub header", () => {
    vi.stubEnv("CODEX_OPENAI_BASE_URL", "https://bb.example/pool/v1");
    vi.stubEnv("CODEX_POOL_AUTH_TOKEN", "secret-machine-token");
    const launch = resolveAppServerLaunch();
    expect(launch.command).toBe("codex");
    expect(launch.args).toContain(
      'openai_base_url="https://bb.example/pool/v1"',
    );
    expect(launch.args).toContain('model_provider="zcc-account-pool"');
    expect(launch.args).toContain(
      'model_providers.zcc-account-pool.env_http_headers.x-bb-account-pool-token="CODEX_POOL_AUTH_TOKEN"',
    );
    expect(launch.args).toContain(
      "model_providers.zcc-account-pool.supports_websockets=false",
    );
    expect(JSON.stringify(launch.args)).not.toContain("secret-machine-token");
  });

  it("leaves Codex's default transport alone when the pool is not routed", () => {
    const launch = resolveAppServerLaunch({});
    expect(launch).toEqual({ command: "codex", args: ["app-server"] });
    expect(JSON.stringify(launch.args)).not.toContain("supports_websockets");
  });

  it("does not partially route when either required variable is missing", () => {
    vi.stubEnv("CODEX_OPENAI_BASE_URL", "https://bb.example/pool/v1");
    expect(resolveAppServerLaunch()).toEqual({
      command: "codex",
      args: ["app-server"],
    });
  });
});
