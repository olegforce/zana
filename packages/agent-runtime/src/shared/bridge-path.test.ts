import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("node:fs", () => ({ existsSync: vi.fn() }));
import { existsSync } from "node:fs";
import { resolveBridgeWorkerProcessArgs, resolveBundledBridgeModulePath } from "./bridge-path.js";

describe("bundled bridge names", () => {
  beforeEach(() => vi.mocked(existsSync).mockReset().mockReturnValue(false));
  it("uses canonical worker and Pi bundle names for new builds", () => {
    expect(resolveBridgeWorkerProcessArgs({ bridgeBundleDir: "/bundle" })).toEqual(["/bundle/zcc-provider-bridge-worker.mjs"]);
    expect(resolveBundledBridgeModulePath({ importMetaUrl: import.meta.url, bridgeRelativePath: "unused", bridgeBundleDir: "/bundle", bundleFileName: "zcc-pi-bridge.mjs" })).toBe("/bundle/zcc-pi-bridge.mjs");
  });
  it("can read older installed bundles, preferring the canonical artifact", () => {
    vi.mocked(existsSync).mockImplementation(path => String(path).includes("/bb-"));
    expect(resolveBridgeWorkerProcessArgs({ bridgeBundleDir: "/bundle" })).toEqual(["/bundle/bb-provider-bridge-worker.mjs"]);
    expect(resolveBundledBridgeModulePath({ importMetaUrl: import.meta.url, bridgeRelativePath: "unused", bridgeBundleDir: "/bundle", bundleFileName: "zcc-pi-bridge.mjs" })).toBe("/bundle/bb-pi-bridge.mjs");
    vi.mocked(existsSync).mockReturnValue(true);
    expect(resolveBridgeWorkerProcessArgs({ bridgeBundleDir: "/bundle" })).toEqual(["/bundle/zcc-provider-bridge-worker.mjs"]);
  });
});
