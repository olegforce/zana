import { describe, expect, it } from "vitest";
import { hostDaemonRpcCommandSchema } from "../src/commands.js";

describe("skill validation branding", () => {
  it.each([
    [{ type: "host.delete_skill", scope: "bb-project", name: "skill", cwd: null, rootPath: null }, "cwd is required to delete a ZCC project skill"],
    [{ type: "host.delete_skill", scope: "bb-user", name: "skill", cwd: null, rootPath: "/other" }, "rootPath must be null for a ZCC skill"],
    [{ type: "host.write_skill", scope: "bb-project", name: "skill", cwd: null, content: "content", expectedSha256: "a".repeat(64) }, "cwd is required to edit a ZCC project skill"],
  ])("presents current product names for invalid requests", (input, message) => {
    const result = hostDaemonRpcCommandSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toContain(message);
  });

  it("continues accepting existing skill scope identifiers", () => {
    for (const scope of ["bb-user", "bb-project"]) {
      expect(hostDaemonRpcCommandSchema.safeParse({ type: "host.delete_skill", scope, name: "skill", cwd: "/project", rootPath: null }).success).toBe(true);
      expect(hostDaemonRpcCommandSchema.safeParse({ type: "host.write_skill", scope, name: "skill", cwd: "/project", content: "content", expectedSha256: "a".repeat(64) }).success).toBe(true);
    }
  });
});
