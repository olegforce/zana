// Adapted from BB under MIT; see docs/third-party/BB-LICENSE.
import { describe, expect, it } from "vitest";
import { operationEnvironment } from "./operation-environment.js";

describe("operation environment", () => {
  it("resolves server-relative values without mutating the daemon environment", () => {
    const base = { ZCC_SERVER_URL: "https://server.example" };
    expect(
      operationEnvironment(
        [
          {
            name: "GH_TOKEN",
            value: "secret",
          },
          {
            name: "PROXY",
            value: { serverPath: "/proxy" },
          },
        ],
        base,
      ),
    ).toEqual({
      ...base,
      GH_TOKEN: "secret",
      PROXY: "https://server.example/proxy",
    });
    expect(base).not.toHaveProperty("GH_TOKEN");
  });
});

it("requires an origin for relative values and strips inherited daemon credentials", () => {
  expect(() => operationEnvironment([{ name: "PROXY", value: { serverPath: "/proxy" } }], {})).toThrow("ZCC_SERVER_URL");
  expect(operationEnvironment([], { HOME: "/tmp/home", ZCC_SERVER_URL: "private" }, true)).toEqual({ HOME: "/tmp/home" });
});
