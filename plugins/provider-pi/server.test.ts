import { describe, expect, it, vi } from "vitest";
import type { ZccPluginApi } from "@zana-ai/zcc-plugin-sdk";
import plugin from "./server.js";
import { piProviderDeclaration } from "./src/declaration.js";

const registeredDeclaration = piProviderDeclaration;

describe("the pi plugin's environment passthrough", () => {
  it("declares the bridge command override variables so a host-set value reaches the bridge", () => {
    expect(registeredDeclaration().env).toEqual({
      passthrough: ["ZCC_PI_BRIDGE_COMMAND", "ZCC_PI_BRIDGE_ARGS", "BB_PI_BRIDGE_COMMAND", "BB_PI_BRIDGE_ARGS"],
    });
  });

  it("registers CLI passthrough and maintenance on the actual plugin entry", () => {
    const register = vi.fn();
    plugin({ agents: { experimental_registerProvider: register } } as unknown as ZccPluginApi);
    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      env: registeredDeclaration().env,
      maintenance: { health: true, usage: false, installation: true },
      capabilities: expect.objectContaining({ permissionModes: ["full"] }),
    }));
  });
});

function rootPaths(
  side: readonly (string | { readonly path: string })[] | undefined,
): string[] {
  return (side ?? []).map((root) =>
    typeof root === "string" ? root : root.path,
  );
}

describe("the pi plugin's skill roots", () => {
  it("declares pi's documented directories and resolves the rest per host", () => {
    const declaration = registeredDeclaration();
    const roots = declaration.experimental_nativeSkillRoots;
    expect(rootPaths(roots?.user)).toEqual([
      ".pi/agent/skills",
      ".agents/skills",
    ]);
    expect(rootPaths(roots?.project)).toEqual([".pi/skills", ".agents/skills"]);
    expect(declaration.experimental_resolvesNativeRoots).toBe(true);
  });
});
