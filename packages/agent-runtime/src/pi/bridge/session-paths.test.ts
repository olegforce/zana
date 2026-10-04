import { beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
vi.mock("node:os", () => ({ homedir: () => "/test/home" }));
vi.mock("node:fs", () => ({ existsSync: vi.fn() }));
import { existsSync } from "node:fs";
import { resolvePiBridgeSessionDir, resolvePiSessionFilePath } from "./session-paths.js";

describe("Pi session paths", () => {
  beforeEach(() => vi.mocked(existsSync).mockReset().mockReturnValue(false));
  it("writes new sessions under ZCC and confines unsafe session keys", () => {
    expect(resolvePiBridgeSessionDir({ env: {} })).toBe("/test/home/.zcc/pi-bridge-sessions");
    expect(resolvePiSessionFilePath({ env: {}, threadId: "../../a/b" })).toBe("/test/home/.zcc/pi-bridge-sessions/.._.._a_b.jsonl");
  });
  it("keeps legacy persisted sessions resumable, preferring the canonical file", () => {
    vi.mocked(existsSync).mockImplementation(path => String(path).includes("/.bb/"));
    expect(resolvePiSessionFilePath({ env: {}, threadId: "old" })).toBe("/test/home/.bb/pi-bridge-sessions/old.jsonl");
    vi.mocked(existsSync).mockReturnValue(true);
    expect(resolvePiSessionFilePath({ env: {}, threadId: "old" })).toBe("/test/home/.zcc/pi-bridge-sessions/old.jsonl");
  });
  it("supports old overrides while giving canonical configuration precedence", () => {
    expect(resolvePiBridgeSessionDir({ env: { BB_PI_BRIDGE_SESSION_DIR: "/legacy" } })).toBe("/legacy");
    const env = { BB_PI_BRIDGE_SESSION_DIR: "/legacy", ZCC_PI_BRIDGE_SESSION_DIR: "/canonical" };
    expect(resolvePiSessionFilePath({ env, threadId: "id" })).toBe(join("/canonical", "id.jsonl"));
    expect(existsSync).not.toHaveBeenCalled();
  });
});
