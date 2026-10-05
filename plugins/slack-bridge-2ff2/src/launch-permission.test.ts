import { describe, expect, it } from "vitest";
import { launchPermission } from "./launch-permission.js";

describe("provider-aware Slack launch permission", () => {
  it.each([
    [["full", "auto", "accept-edits"], "accept-edits"],
    [["full", "auto"], "auto"],
    [["full"], "full"],
    [[], undefined],
    [["unknown"], undefined],
  ] as const)("selects from declared modes %j", (permissionModes, expected) => {
    expect(
      launchPermission({
        id: "provider",
        available: true,
        capabilities: { permissionModes: [...permissionModes] },
      }),
    ).toBe(expected);
  });
  it("preserves older providers and rejects unavailable or absent providers", () => {
    expect(launchPermission({ id: "old", available: true })).toBe(
      "accept-edits",
    );
    expect(
      launchPermission({
        id: "off",
        available: false,
        capabilities: { permissionModes: ["full"] },
      }),
    ).toBeUndefined();
    expect(launchPermission(undefined)).toBeUndefined();
  });
});
